// Native regression test; writes only inside its own unique temporary folder.
// The production counter reads no key identities, so tests supply only event
// type and make/break flags. No input is injected into the user's desktop.
#include "../src/keystroke_counter.cpp"

static void Print(const char* text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, lstrlenA(text), &written, nullptr);
}

static bool Append(const wchar_t* path, const char* text) {
    HANDLE file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const DWORD length = static_cast<DWORD>(lstrlenA(text));
    const bool okay = WriteFile(file, text, length, &written, nullptr) && written == length;
    CloseHandle(file);
    return okay;
}

static ULONGLONG Load(const wchar_t* path) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return kMaximum;
    const ULONGLONG total = ReadTotal(file);
    CloseHandle(file);
    return total;
}

static bool VerifyLocation(const wchar_t* workingDirectory) {
    wchar_t previous[MAX_PATH];
    wchar_t expected[MAX_PATH];
    if (!GetCurrentDirectoryW(MAX_PATH, previous)) return false;
    const DWORD length = GetModuleFileNameW(nullptr, expected, MAX_PATH);
    if (!length || length >= MAX_PATH) return false;
    DWORD start = length;
    while (start && expected[start - 1] != L'\\') --start;
    if (!start || start + 13 > MAX_PATH) return false;
    lstrcpyW(expected + start, L"yourtext.txt");
    if (!SetCurrentDirectoryW(workingDirectory)) return false;
    wchar_t* resolved = ResolveCountPath();
    const bool matches = resolved && lstrcmpW(expected, resolved) == 0;
    if (resolved) HeapFree(GetProcessHeap(), 0, resolved);
    const bool restored = SetCurrentDirectoryW(previous) != FALSE;
    if (matches && restored) Print("PASS: count path stays beside the executable with a different working directory.\r\n");
    return matches && restored;
}

static DWORD Verify(const wchar_t* path, HWND window) {
    const char* sentinel = "Preserve existing file content.";
    if (!Append(path, sentinel)) return 10;
    counter.path = const_cast<wchar_t*>(path);
    CountEvent(window, RIM_TYPEMOUSE, 0);
    CountEvent(window, RIM_TYPEKEYBOARD, RI_KEY_BREAK);
    if (counter.total || counter.timerArmed) return 11;
    for (unsigned i = 0; i < 100000; ++i) CountEvent(window, RIM_TYPEKEYBOARD, 0);
    if (counter.total != 100000 || !counter.timerArmed || !counter.pending) return 12;
    if (Load(path) != 0) return 13; // Batched: no file writes per event.
    if (!SaveTotal() || counter.pending || Load(path) != 100000) return 14;
    Print("PASS: key-down counts; ignore releases/mouse; 100,000 events batched.\r\n");
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    char first[32];
    DWORD read = 0;
    if (file == INVALID_HANDLE_VALUE) return 15;
    const BOOL readOkay = ReadFile(file, first, lstrlenA(sentinel), &read, nullptr);
    CloseHandle(file);
    if (!readOkay || read != static_cast<DWORD>(lstrlenA(sentinel))) return 16;
    for (DWORD i = 0; i < read; ++i) if (first[i] != sentinel[i]) return 17;
    counter.total = Load(path); // Simulate restoring the next process's total.
    counter.saved = counter.total;
    CountEvent(window, RIM_TYPEKEYBOARD, RI_KEY_E0);
    CountEvent(window, RIM_TYPEKEYBOARD, RI_KEY_E1);
    CountEvent(window, RIM_TYPEKEYBOARD, RI_KEY_BREAK | RI_KEY_E0);
    if (counter.total != 100002) return 18;
    SendMessageW(window, WM_TIMER, kSaveTimer, 0);
    if (Load(path) != 100002 || counter.timerArmed || counter.pending) return 19;
    Print("PASS: existing content preserved; total restored; extended keys; timer flush.\r\n");
    if (!Append(path, "Total key presses: 18446744073709551616\r\nTotal key presses: 999")) return 20;
    if (Load(path) != 100002) return 21;
    CountEvent(window, RIM_TYPEKEYBOARD, 0);
    if (!SaveTotal() || Load(path) != 100003) return 22;
    Print("PASS: overflow/partial records ignored; valid append restores parsing.\r\n");
    wchar_t invalid[MAX_PATH];
    lstrcpyW(invalid, path);
    lstrcatW(invalid, L"\\missing\\yourtext.txt");
    counter.path = invalid;
    CountEvent(window, RIM_TYPEKEYBOARD, 0);
    if (SaveTotal() || !counter.pending) return 23;
    counter.path = const_cast<wchar_t*>(path);
    if (!SaveTotal() || Load(path) != 100004) return 24;
    // Preserve the cumulative total when the acknowledged text file is empty.
    // Use a unique test registry key, never the application's real checkpoint.
    wchar_t key[128];
    lstrcpyW(key, L"Software\\PDF\\Tests\\CounterCheckpoint-");
    wchar_t pidDigits[16];
    DWORD pid = GetCurrentProcessId();
    unsigned pidCount = 0;
    do { pidDigits[pidCount++] = static_cast<wchar_t>(L'0' + pid % 10); pid /= 10; } while (pid);
    unsigned keyLength = static_cast<unsigned>(lstrlenW(key));
    while (pidCount) key[keyLength++] = pidDigits[--pidCount];
    key[keyLength] = 0;
    HKEY testKey = nullptr;
    DWORD disposition = 0;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, key, 0, nullptr, REG_OPTION_NON_VOLATILE,
        KEY_SET_VALUE, nullptr, &testKey, &disposition) != ERROR_SUCCESS) return 26;
    RegCloseKey(testKey);
    if (disposition != REG_CREATED_NEW_KEY) return 27;
    const bool checkpointWritten = WriteCheckpoint(counter.saved, key);
    file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    const bool cleared = file != INVALID_HANDLE_VALUE && SetEndOfFile(file);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    counter.total = Load(path);
    RestoreCheckpoint(key);
    const bool restored = counter.total == 100004 && counter.saved == 100004;
    RegDeleteKeyW(HKEY_CURRENT_USER, key);
    if (!checkpointWritten || !cleared || !restored) return 28;
    CountEvent(window, RIM_TYPEKEYBOARD, 0);
    if (!SaveTotal() || Load(path) != 100005) return 29;
    Print("PASS: cumulative total survives clearing the file and restarting.\r\n");
    counter.total = kMaximum;
    counter.saved = kMaximum;
    counter.pending = false;
    CountEvent(window, RIM_TYPEKEYBOARD, 0);
    if (counter.total != kMaximum || counter.pending) return 25;
    Print("PASS: failed writes retain pending counts; counter never wraps.\r\n");
    return 0;
}

extern "C" void WINAPI EntryPoint() {
    wchar_t directory[MAX_PATH];
    wchar_t path[MAX_PATH];
    if (!GetTempPathW(MAX_PATH - 50, directory)) ExitProcess(1);
    wchar_t digits[16];
    DWORD pid = GetCurrentProcessId();
    unsigned count = 0;
    do { digits[count++] = static_cast<wchar_t>(L'0' + pid % 10); pid /= 10; } while (pid);
    lstrcatW(directory, L"PDF-Counter-Test-");
    unsigned length = static_cast<unsigned>(lstrlenW(directory));
    while (count) directory[length++] = digits[--count];
    directory[length] = 0;
    if (!CreateDirectoryW(directory, nullptr)) ExitProcess(2);
    lstrcpyW(path, directory);
    lstrcatW(path, L"\\counts.txt");
    WNDCLASSW cls = {};
    cls.lpfnWndProc = CounterWindow;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = L"PDF.CounterTest.MessageOnly";
    RegisterClassW(&cls);
    HWND window = CreateWindowExW(0, cls.lpszClassName, L"", 0, 0, 0, 0, 0,
                                 HWND_MESSAGE, nullptr, cls.hInstance, nullptr);
    const DWORD result = !VerifyLocation(directory) ? 30 : (window ? Verify(path, window) : 3);
    if (counter.timerArmed) KillTimer(window, kSaveTimer);
    if (window) DestroyWindow(window);
    UnregisterClassW(cls.lpszClassName, cls.hInstance);
    DeleteFileW(path);
    RemoveDirectoryW(directory);
    if (result) Print("FAIL: counter regression.\r\n");
    ExitProcess(result);
}
