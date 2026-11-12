#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <sddl.h>
#include "keystroke_counter.h"

// The process has no CRT, visible GUI or console.
// The SID is used only to scope kernel object names to the current user.
static bool ObjectNames(wchar_t* mutexName, wchar_t* eventName, PSECURITY_DESCRIPTOR* security) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    alignas(TOKEN_USER) BYTE storage[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
    DWORD length = 0;
    const BOOL read = GetTokenInformation(token, TokenUser, storage, sizeof(storage), &length);
    CloseHandle(token);
    if (!read) return false;
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(storage)->User.Sid, &sid)) return false;
    // A SID string is at most 184 characters; callers provide 256 WCHARs.
    lstrcpyW(mutexName, L"Global\\PDF.059BEB10-6FB0-4B88-A6E0-2EA7907C1B75.");
    lstrcatW(mutexName, sid);
    lstrcpyW(eventName, mutexName);
    lstrcatW(mutexName, L".Instance");
    lstrcatW(eventName, L".Stop");
    // Use explicit per-user access and medium integrity so maintenance works
    // even if an earlier instance was launched from an elevated shell.
    wchar_t descriptor[256];
    lstrcpyW(descriptor, L"D:P(A;;GA;;;");
    lstrcatW(descriptor, sid);
    lstrcatW(descriptor, L")(A;;GA;;;SY)S:(ML;;NW;;;ME)");
    const BOOL secured = ConvertStringSecurityDescriptorToSecurityDescriptorW(
        descriptor, SDDL_REVISION_1, security, nullptr);
    LocalFree(sid);
    return secured != FALSE;
}

static const wchar_t* Arguments() {
    const wchar_t* p = GetCommandLineW();
    if (*p == L'"') {
        ++p;
        while (*p && *p != L'"') ++p;
        if (*p) ++p;
    } else {
        while (*p && *p != L' ' && *p != L'\t') ++p;
    }
    while (*p == L' ' || *p == L'\t') ++p;
    return p;
}

static bool IsStopArgument(const wchar_t* p) {
    const bool quoted = *p == L'"';
    if (quoted) ++p;
    const wchar_t expected[] = L"--stop";
    for (unsigned i = 0; i < 6; ++i) {
        if (*p++ != expected[i]) return false;
    }
    if (quoted && *p++ != L'"') return false;
    while (*p == L' ' || *p == L'\t') ++p;
    return *p == L'\0';
}

// Installer maintenance only: signal the sleeping process and wait for its lock.
static DWORD Stop(const wchar_t* mutexName, const wchar_t* eventName) {
    HANDLE mutex = OpenMutexW(SYNCHRONIZE | MUTEX_MODIFY_STATE, FALSE, mutexName);
    if (!mutex) {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND ? 0 : error;
    }
    HANDLE event = nullptr;
    for (unsigned attempt = 0; attempt < 100; ++attempt) {
        event = OpenEventW(EVENT_MODIFY_STATE, FALSE, eventName);
        if (event) break;
        const DWORD state = WaitForSingleObject(mutex, 10);
        if (state == WAIT_OBJECT_0 || state == WAIT_ABANDONED) {
            ReleaseMutex(mutex);
            CloseHandle(mutex);
            return 0;
        }
    }
    DWORD result = event ? ERROR_SUCCESS : GetLastError();
    if (event && SetEvent(event)) {
        const DWORD state = WaitForSingleObject(mutex, 10000);
        if (state == WAIT_OBJECT_0 || state == WAIT_ABANDONED) {
            ReleaseMutex(mutex);
            result = 0;
        } else {
            result = state == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
        }
    } else if (event) {
        result = GetLastError();
    }
    if (event) CloseHandle(event);
    CloseHandle(mutex);
    return result;
}

static DWORD Run() {
    wchar_t mutexName[256];
    wchar_t eventName[256];
    PSECURITY_DESCRIPTOR security = nullptr;
    if (!ObjectNames(mutexName, eventName, &security)) return GetLastError();
    const wchar_t* args = Arguments();
    if (*args) {
        LocalFree(security);
        return IsStopArgument(args) ? Stop(mutexName, eventName) : 2;
    }

    SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), security, FALSE};
    HANDLE mutex = CreateMutexExW(&attributes, mutexName, 0, SYNCHRONIZE | MUTEX_MODIFY_STATE);
    if (!mutex) {
        LocalFree(security);
        return 1;
    }
    const DWORD ownership = WaitForSingleObject(mutex, 0);
    if (ownership != WAIT_OBJECT_0 && ownership != WAIT_ABANDONED) {
        LocalFree(security);
        CloseHandle(mutex);
        return ownership == WAIT_TIMEOUT ? 0 : 1;
    }
    HANDLE event = CreateEventW(&attributes, TRUE, FALSE, eventName);
    LocalFree(security);
    DWORD result = 1;
    if (event) {
        ResetEvent(event);
        result = RunKeystrokeCounter(event);
        CloseHandle(event);
    }
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return result;
}

extern "C" void WINAPI EntryPoint() {
    ExitProcess(Run());
}
