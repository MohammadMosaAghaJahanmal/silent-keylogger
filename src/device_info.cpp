#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include "device_info.h"

namespace {
bool ValidId(const wchar_t* text) {
    for (unsigned i = 0; i < 36; ++i) {
        const wchar_t c = text[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != L'-') return false;
        } else if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f')
                   || (c >= L'A' && c <= L'F'))) return false;
    }
    return text[36] == 0;
}
bool InstallationId(char* output, const wchar_t* stateKey) {
    HKEY key;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, stateKey, 0, nullptr, 0,
        KEY_QUERY_VALUE | KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
    wchar_t value[37];
    DWORD size = sizeof(value);
    bool okay = RegGetValueW(key, nullptr, L"InstallationId", RRF_RT_REG_SZ,
        nullptr, value, &size) == ERROR_SUCCESS && size == sizeof(value) && ValidId(value);
    if (!okay) {
        GUID guid;
        wchar_t formatted[39];
        okay = CoCreateGuid(&guid) == S_OK && StringFromGUID2(guid, formatted, 39) == 39;
        if (okay) {
            lstrcpynW(value, formatted + 1, 37); // Excludes GUID braces, adds NUL.
            okay = RegSetValueExW(key, L"InstallationId", 0, REG_SZ,
                reinterpret_cast<const BYTE*>(value), sizeof(value)) == ERROR_SUCCESS;
        }
    }
    RegCloseKey(key);
    if (!okay) return false; // Keep the count file for retry if ID persistence fails.
    for (unsigned i = 0; i <= 36; ++i) {
        output[i] = static_cast<char>(value[i]);
        if (output[i] >= 'A' && output[i] <= 'F') output[i] += 'a' - 'A';
    }
    return true;
}
void WindowsVersion(char* output) {
    wchar_t value[16];
    DWORD size = sizeof(value);
    DWORD build = 0;
    // The build label avoids manifest-dependent version APIs and ProductName's
    // legacy "Windows 10" label on Windows 11. No product key is read.
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
        L"CurrentBuildNumber", RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
        nullptr, value, &size) == ERROR_SUCCESS && size > sizeof(wchar_t)) {
        for (unsigned i = 0; i < 15 && value[i]; ++i) {
            if (value[i] < L'0' || value[i] > L'9' || build > 1000000) { build = 0; break; }
            build = build * 10 + static_cast<DWORD>(value[i] - L'0');
        }
    }
    if (!build) { lstrcpyA(output, "Windows (x64)"); return; }
    lstrcpyA(output, build >= 22000 ? "Windows 11 (build " : "Windows 10 (build ");
    char digits[11];
    unsigned length = 0;
    do { digits[length++] = static_cast<char>('0' + build % 10); build /= 10; } while (build);
    char* end = output + lstrlenA(output);
    while (length) *end++ = digits[--length];
    lstrcpyA(end, "), x64");
}
} // namespace

bool LoadDeviceInfo(DeviceInfo& info, const wchar_t* stateKey) {
    if (!InstallationId(info.id, stateKey)) return false;
    wchar_t name[256];
    DWORD length = 256;
    if (!GetComputerNameExW(ComputerNamePhysicalDnsHostname, name, &length)
        || !length || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, -1,
                                         info.name, sizeof(info.name), nullptr, nullptr)) {
        lstrcpyA(info.name, "Unknown device");
    }
    WindowsVersion(info.osVersion);
    return true;
}
