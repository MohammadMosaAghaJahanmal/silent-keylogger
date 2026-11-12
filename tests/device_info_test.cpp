#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include "../src/device_info.h"

static void Print(const char* text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, lstrlenA(text), &written, nullptr);
}
__declspec(noinline) static DWORD Test(const wchar_t* key) {
    DeviceInfo first;
    DeviceInfo second;
    if (!LoadDeviceInfo(first, key) || !LoadDeviceInfo(second, key)
        || lstrlenA(first.id) != 36 || lstrcmpA(first.id, second.id)) return 1;
    wchar_t stored[37];
    DWORD size = sizeof(stored);
    if (RegGetValueW(HKEY_CURRENT_USER, key, L"InstallationId", RRF_RT_REG_SZ,
        nullptr, stored, &size) != ERROR_SUCCESS || size != sizeof(stored)) return 2;
    for (unsigned i = 0; i < 36; ++i) {
        char c = static_cast<char>(stored[i]);
        if (c >= 'A' && c <= 'F') c += 'a' - 'A';
        if (c != first.id[i]) return 3;
    }
    Print("PASS: generated application UUID is persisted and stable across reads.\r\n");
    wchar_t actual[256];
    DWORD length = 256;
    wchar_t decoded[256];
    if (!GetComputerNameExW(ComputerNamePhysicalDnsHostname, actual, &length)
        || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, first.name, -1, decoded, 256)
        || lstrcmpW(actual, decoded) || !first.osVersion[0]) return 4;
    Print("PASS: device name is valid UTF-8 and matches the Windows hostname; OS label is present.\r\n");
    HKEY state;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, key, 0, KEY_SET_VALUE, &state) != ERROR_SUCCESS) return 5;
    constexpr wchar_t invalid[] = L"invalid";
    const LONG written = RegSetValueExW(state, L"InstallationId", 0, REG_SZ,
        reinterpret_cast<const BYTE*>(invalid), sizeof(invalid));
    RegCloseKey(state);
    if (written != ERROR_SUCCESS || !LoadDeviceInfo(second, key)
        || lstrlenA(second.id) != 36 || !lstrcmpA(first.id, second.id)) return 6;
    DeviceInfo restored;
    if (!LoadDeviceInfo(restored, key) || lstrcmpA(restored.id, second.id)) return 7;
    Print("PASS: an invalid saved identifier is replaced once and the replacement stays stable.\r\n");
    return 0;
}
extern "C" void WINAPI EntryPoint() {
    GUID guid;
    wchar_t formatted[39];
    if (CoCreateGuid(&guid) != S_OK || StringFromGUID2(guid, formatted, 39) != 39) ExitProcess(8);
    wchar_t key[100];
    lstrcpyW(key, L"Software\\PDF-DeviceTest-");
    lstrcatW(key, formatted);
    const DWORD result = Test(key);
    // Only this test's unique, app-independent key, containing no subkeys.
    RegDeleteKeyW(HKEY_CURRENT_USER, key);
    if (result) Print("FAIL: device information native test.\r\n");
    ExitProcess(result);
}
