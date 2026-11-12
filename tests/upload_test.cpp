// Integration harness: synthetic count events and test files only. No keyboard
// input is injected and no application state checkpoint is modified.
#include "../src/keystroke_counter.cpp"
#include <shellapi.h>
#include "../src/device_info.h"

static void Print(const char* text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, lstrlenA(text), &written, nullptr);
}
static bool TestCheckpoint(void* context) { return *static_cast<bool*>(context); }
static bool WaitForMarker(const wchar_t* path, DWORD timeout) {
    const ULONGLONG start = GetTickCount64();
    while (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) {
        if (GetTickCount64() - start >= timeout) return false;
        Sleep(5);
    }
    return true;
}
struct OnceContext { CountUploadSource* source; bool result; };
static DWORD WINAPI Once(void* context) {
    OnceContext* value = static_cast<OnceContext*>(context);
    value->result = UploadCountFileOnce(*value->source);
    return 0;
}

static DWORD RunTest(int argc, wchar_t** args) {
    if (argc < 3) return 10;
    HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stop) return 11;
    bool checkpoint = lstrcmpW(args[1], L"checkpoint_fail") != 0;
    CountUploadSource source = {args[2], &counter.fileLock, stop, TestCheckpoint, &checkpoint};
    static const DeviceInfo device = {"12345678-1234-4567-89ab-123456789abc", "TEST-DEVICE", "Windows 11 (build 26200), x64"};
    source.device = &device;
    wchar_t testPort[8];
    const DWORD length = GetEnvironmentVariableW(L"PDF_TEST_PORT", testPort, 8);
    if (length) {
        if (length >= 8) return 21;
        DWORD port = 0;
        for (DWORD i = 0; i < length; ++i) {
            if (testPort[i] < L'0' || testPort[i] > L'9') return 21;
            port = port * 10 + static_cast<DWORD>(testPort[i] - L'0');
        }
        if (!port || port > 65535) return 21;
        source.port = static_cast<unsigned short>(port);
    }
    DWORD result = 0;
    if (lstrcmpW(args[1], L"worker") == 0) {
        HANDLE worker = StartCountUploader(&source, 200);
        if (!worker) return 12;
        Sleep(550);
        SetEvent(stop);
        result = WaitForSingleObject(worker, 6000) == WAIT_OBJECT_0 ? 0 : 13;
        CloseHandle(worker);
    } else if (lstrcmpW(args[1], L"stop") == 0 && argc == 4) {
        HANDLE worker = StartCountUploader(&source, 50);
        if (!worker) return 14;
        if (!WaitForMarker(args[3], 5000)) return 15;
        const ULONGLONG start = GetTickCount64();
        SetEvent(stop);
        result = WaitForSingleObject(worker, 6000) == WAIT_OBJECT_0 && GetTickCount64() - start < 5500 ? 0 : 16;
        CloseHandle(worker);
    } else if (lstrcmpW(args[1], L"nonblocking") == 0 && argc == 4) {
        counter.path = args[2];
        HANDLE file = CreateFileW(args[2], GENERIC_READ, FILE_SHARE_READ, nullptr,
                                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) return 17;
        counter.total = ReadTotal(file);
        counter.saved = counter.total;
        CloseHandle(file);
        WNDCLASSW cls = {};
        cls.lpfnWndProc = CounterWindow;
        cls.hInstance = GetModuleHandleW(nullptr);
        cls.lpszClassName = L"PDF.UploadTest.MessageOnly";
        RegisterClassW(&cls);
        HWND window = CreateWindowExW(0, cls.lpszClassName, L"", 0, 0, 0, 0, 0,
                                     HWND_MESSAGE, nullptr, cls.hInstance, nullptr);
        if (!window) return 18;
        OnceContext context = {&source, false};
        HANDLE request = CreateThread(nullptr, 0, Once, &context, 0, nullptr);
        if (!request || !WaitForMarker(args[3], 5000)) return 19;
        const ULONGLONG start = GetTickCount64();
        for (unsigned i = 0; i < 100000; ++i) CountEvent(window, RIM_TYPEKEYBOARD, 0);
        const bool saved = SaveTotal();
        const bool responsive = GetTickCount64() - start < 500;
        result = saved && responsive && WaitForSingleObject(request, 7000) == WAIT_OBJECT_0 && context.result ? 0 : 20;
        KillTimer(window, kSaveTimer);
        DestroyWindow(window);
        UnregisterClassW(cls.lpszClassName, cls.hInstance);
        CloseHandle(request);
        if (!result) Print("PASS: 100,000 count events and saving completed while HTTP response was delayed.\r\n");
    } else {
        result = UploadCountFileOnce(source) ? 0 : 1;
    }
    CloseHandle(stop);
    return result;
}

extern "C" void WINAPI EntryPoint() {
    int argc = 0;
    wchar_t** args = CommandLineToArgvW(GetCommandLineW(), &argc);
    const DWORD result = args ? RunTest(argc, args) : 9;
    if (args) LocalFree(args);
    ExitProcess(result);
}
