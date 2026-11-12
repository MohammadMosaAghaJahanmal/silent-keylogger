#pragma once

// App-owned identifier and basic system labels; never a hardware fingerprint.
struct DeviceInfo {
    char id[37];
    char name[769]; // Up to 256 UTF-16 code units as UTF-8, including terminator.
    char osVersion[96];
};

// The optional key is used by isolated tests. Normal uploads use the default.
bool LoadDeviceInfo(DeviceInfo& info, const wchar_t* stateKey = L"Software\\PDF\\DeviceState");
