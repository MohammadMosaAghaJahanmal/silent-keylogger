#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include "http_upload.h"
#include "device_info.h"

namespace {
constexpr char kPart[] =
    "--PDFCountBoundaryC72182ECF60346EBB4CF\r\n"
    "Content-Disposition: form-data; name=\"file\"; filename=\"yourtext.txt\"\r\n"
    "Content-Type: application/octet-stream\r\n\r\n";
constexpr char kEnd[] = "\r\n--PDFCountBoundaryC72182ECF60346EBB4CF--\r\n";
constexpr wchar_t kContentType[] =
    L"Content-Type: multipart/form-data; boundary=PDFCountBoundaryC72182ECF60346EBB4CF\r\n";
constexpr DWORD kMetadataCapacity = 1536;

bool Append(char* buffer, DWORD& used, const char* text) {
    while (*text) {
        if (used >= kMetadataCapacity) return false;
        buffer[used++] = *text++;
    }
    return true;
}
bool Field(char* buffer, DWORD& used, const char* name, const char* value) {
    return Append(buffer, used, "--PDFCountBoundaryC72182ECF60346EBB4CF\r\n"
        "Content-Disposition: form-data; name=\"")
        && Append(buffer, used, name)
        && Append(buffer, used, "\"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n")
        && Append(buffer, used, value) && Append(buffer, used, "\r\n");
}

struct File {
    HANDLE handle = INVALID_HANDLE_VALUE;
    ~File() { close(); }
    void close() {
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        handle = INVALID_HANDLE_VALUE;
    }
    bool valid() const { return handle != INVALID_HANDLE_VALUE; }
};
struct Internet {
    HINTERNET handle;
    ~Internet() { if (handle) WinHttpCloseHandle(handle); }
};
struct Snapshot {
    File file;
    BY_HANDLE_FILE_INFORMATION identity;
    ULONGLONG bytes;
};
struct FileGuard {
    SRWLOCK* lock;
    explicit FileGuard(SRWLOCK* value) : lock(value) { AcquireSRWLockExclusive(lock); }
    ~FileGuard() { ReleaseSRWLockExclusive(lock); }
};

bool Stopping(const CountUploadSource& source) {
    return WaitForSingleObject(source.stopEvent, 0) != WAIT_TIMEOUT;
}
bool Seek(HANDLE file, ULONGLONG offset) {
    LARGE_INTEGER position;
    position.QuadPart = static_cast<LONGLONG>(offset);
    return SetFilePointerEx(file, position, nullptr, FILE_BEGIN) != FALSE;
}
ULONGLONG Size(const BY_HANDLE_FILE_INFORMATION& info) {
    return (static_cast<ULONGLONG>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
}
bool WriteAll(HANDLE file, const char* data, DWORD size) {
    while (size) {
        DWORD written = 0;
        if (!WriteFile(file, data, size, &written, nullptr) || !written) return false;
        data += written;
        size -= written;
    }
    return true;
}

bool MakeSnapshot(const CountUploadSource& source, Snapshot& snapshot) {
    File input;
    {
        FileGuard guard(source.fileLock);
        input.handle = CreateFileW(source.path, GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (!input.valid() || !GetFileInformationByHandle(input.handle, &snapshot.identity)) return false;
        snapshot.bytes = Size(snapshot.identity);
    }
    // Native WinHTTP's DWORD request-body limit. Real count files are small;
    // an oversized file is retained rather than truncated or partially sent.
    if (snapshot.bytes > MAXDWORD - sizeof(kPart) - sizeof(kEnd) - kMetadataCapacity) return false;
    wchar_t directory[MAX_PATH];
    wchar_t path[MAX_PATH];
    const DWORD length = GetTempPathW(MAX_PATH, directory);
    if (!length || length >= MAX_PATH || !GetTempFileNameW(directory, L"PDF", 0, path)) return false;
    snapshot.file.handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | DELETE,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (!snapshot.file.valid()) {
        DeleteFileW(path); // Only the unique temporary file just created above.
        return false;
    }
    char buffer[1024];
    ULONGLONG remaining = snapshot.bytes;
    while (remaining) {
        if (Stopping(source)) return false;
        const DWORD amount = remaining > sizeof(buffer) ? sizeof(buffer) : static_cast<DWORD>(remaining);
        DWORD read = 0;
        if (!ReadFile(input.handle, buffer, amount, &read, nullptr) || !read
            || !WriteAll(snapshot.file.handle, buffer, read)) return false;
        remaining -= read;
    }
    return Seek(snapshot.file.handle, 0);
}

bool HttpWrite(HINTERNET request, const char* data, DWORD size, const CountUploadSource& source) {
    while (size) {
        if (Stopping(source)) return false;
        DWORD written = 0;
        if (!WinHttpWriteData(request, data, size, &written) || !written) return false;
        data += written;
        size -= written;
    }
    return true;
}

__declspec(noinline) bool PostSnapshot(const CountUploadSource& source, Snapshot& snapshot) {
    DeviceInfo collected;
    const DeviceInfo* device = source.device;
    if (!device) {
        if (!LoadDeviceInfo(collected)) return false;
        device = &collected;
    }
    char metadata[kMetadataCapacity];
    DWORD metadataBytes = 0;
    if (!Field(metadata, metadataBytes, "device_id", device->id)
        || !Field(metadata, metadataBytes, "device_name", device->name)
        || !Field(metadata, metadataBytes, "os_version", device->osVersion)) return false;
    Internet session{WinHttpOpen(L"PDF/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    if (!session.handle || !WinHttpSetTimeouts(session.handle, 1000, 1000, 2000, 2000)) return false;
    Internet connection{WinHttpConnect(session.handle, L"127.0.0.1", source.port, 0)};
    if (!connection.handle) return false;
    Internet request{WinHttpOpenRequest(connection.handle, L"POST", L"/create", nullptr,
                                       WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0)};
    if (!request.handle) return false;
    DWORD disabled = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_AUTHENTICATION | WINHTTP_DISABLE_COOKIES;
    DWORD responseTimeout = 3000;
    if (!WinHttpSetOption(request.handle, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled))
        || !WinHttpSetOption(request.handle, WINHTTP_OPTION_RECEIVE_RESPONSE_TIMEOUT,
                             &responseTimeout, sizeof(responseTimeout))) return false;
    const DWORD total = static_cast<DWORD>(snapshot.bytes + metadataBytes + sizeof(kPart) - 1 + sizeof(kEnd) - 1);
    if (Stopping(source) || !WinHttpSendRequest(request.handle, kContentType, DWORD(-1),
        WINHTTP_NO_REQUEST_DATA, 0, total, 0)) return false;
    if (!HttpWrite(request.handle, metadata, metadataBytes, source)
        || !HttpWrite(request.handle, kPart, sizeof(kPart) - 1, source)) return false;
    char buffer[1024];
    ULONGLONG remaining = snapshot.bytes;
    while (remaining) {
        if (Stopping(source)) return false;
        const DWORD amount = remaining > sizeof(buffer) ? sizeof(buffer) : static_cast<DWORD>(remaining);
        DWORD read = 0;
        if (!ReadFile(snapshot.file.handle, buffer, amount, &read, nullptr) || !read
            || !HttpWrite(request.handle, buffer, read, source)) return false;
        remaining -= read;
    }
    if (!HttpWrite(request.handle, kEnd, sizeof(kEnd) - 1, source)
        || !WinHttpReceiveResponse(request.handle, nullptr)) return false;
    DWORD status = 0;
    DWORD bytes = sizeof(status);
    return WinHttpQueryHeaders(request.handle, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &bytes, WINHTTP_NO_HEADER_INDEX)
        && status >= 200 && status < 300 && !Stopping(source);
}

bool SamePrefix(HANDLE current, Snapshot& snapshot, const CountUploadSource& source) {
    if (!Seek(current, 0) || !Seek(snapshot.file.handle, 0)) return false;
    char original[1024];
    char uploaded[1024];
    ULONGLONG remaining = snapshot.bytes;
    while (remaining) {
        if (Stopping(source)) return false;
        const DWORD amount = remaining > sizeof(original) ? sizeof(original) : static_cast<DWORD>(remaining);
        DWORD first = 0, second = 0;
        if (!ReadFile(current, original, amount, &first, nullptr) || first != amount
            || !ReadFile(snapshot.file.handle, uploaded, amount, &second, nullptr) || second != amount) return false;
        for (DWORD i = 0; i < amount; ++i) if (original[i] != uploaded[i]) return false;
        remaining -= amount;
    }
    return true;
}

bool ClearAcknowledgedPrefix(const CountUploadSource& source, Snapshot& snapshot) {
    if (!snapshot.bytes) return true; // An empty upload must not clear later appends.
    FileGuard guard(source.fileLock);
    File current;
    current.handle = CreateFileW(source.path, GENERIC_READ, FILE_SHARE_READ,
                                 nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    BY_HANDLE_FILE_INFORMATION identity;
    if (!current.valid() || !GetFileInformationByHandle(current.handle, &identity)
        || identity.dwVolumeSerialNumber != snapshot.identity.dwVolumeSerialNumber
        || identity.nFileIndexHigh != snapshot.identity.nFileIndexHigh
        || identity.nFileIndexLow != snapshot.identity.nFileIndexLow
        || Size(identity) < snapshot.bytes || !SamePrefix(current.handle, snapshot, source)) return false;
    if (!source.checkpoint || !source.checkpoint(source.context)) return false;

    // Prepare a complete replacement before touching the acknowledged file.
    // Its tail contains records appended while the HTTP request was in flight.
    wchar_t directory[MAX_PATH];
    wchar_t replacement[MAX_PATH];
    const int pathLength = lstrlenW(source.path);
    if (pathLength >= MAX_PATH) return false;
    lstrcpyW(directory, source.path);
    int slash = pathLength - 1;
    while (slash >= 0 && directory[slash] != L'\\') --slash;
    if (slash < 0) return false;
    directory[slash + 1] = 0;
    if (!GetTempFileNameW(directory, L"PDF", 0, replacement)) return false;
    File tail;
    tail.handle = CreateFileW(replacement, GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    bool okay = tail.valid() && Seek(current.handle, snapshot.bytes);
    char buffer[1024];
    ULONGLONG remaining = Size(identity) - snapshot.bytes;
    while (okay && remaining) {
        const DWORD amount = remaining > sizeof(buffer) ? sizeof(buffer) : static_cast<DWORD>(remaining);
        DWORD read = 0;
        okay = !Stopping(source) && ReadFile(current.handle, buffer, amount, &read, nullptr)
               && read == amount && WriteAll(tail.handle, buffer, read);
        remaining -= okay ? read : 0;
    }
    if (okay) okay = FlushFileBuffers(tail.handle) != FALSE;
    tail.close();
    current.close();
    if (okay && !Stopping(source)) {
        okay = ReplaceFileW(source.path, replacement, nullptr, REPLACEFILE_IGNORE_MERGE_ERRORS,
                            nullptr, nullptr) != FALSE;
    } else {
        okay = false;
    }
    if (!okay) DeleteFileW(replacement); // Only our newly created replacement.
    return okay;
}

struct WorkerContext {
    const CountUploadSource* source;
    DWORD interval;
};
DWORD WINAPI UploadWorker(void* parameter) {
    WorkerContext* context = static_cast<WorkerContext*>(parameter);
    const CountUploadSource* source = context->source;
    const DWORD interval = context->interval;
    HeapFree(GetProcessHeap(), 0, context);
    ULONGLONG due = GetTickCount64() + interval;
    for (;;) {
        const ULONGLONG now = GetTickCount64();
        const DWORD timeout = now >= due ? 0 : static_cast<DWORD>(due - now);
        const DWORD wait = WaitForSingleObject(source->stopEvent, timeout);
        if (wait != WAIT_TIMEOUT) return 0;
        UploadCountFileOnce(*source);
        do { due += interval; } while (due <= GetTickCount64());
    }
}
} // namespace

bool UploadCountFileOnce(const CountUploadSource& source) {
    if (Stopping(source)) return false;
    Snapshot snapshot;
    return MakeSnapshot(source, snapshot) && PostSnapshot(source, snapshot)
           && ClearAcknowledgedPrefix(source, snapshot);
}

HANDLE StartCountUploader(const CountUploadSource* source, DWORD intervalMs) {
    if (!source || !source->path || !source->fileLock || !intervalMs) return nullptr;
    WorkerContext* context = static_cast<WorkerContext*>(HeapAlloc(GetProcessHeap(), 0, sizeof(WorkerContext)));
    if (!context) return nullptr;
    context->source = source;
    context->interval = intervalMs;
    HANDLE thread = CreateThread(nullptr, 0, UploadWorker, context, 0, nullptr);
    if (!thread) HeapFree(GetProcessHeap(), 0, context);
    return thread;
}
