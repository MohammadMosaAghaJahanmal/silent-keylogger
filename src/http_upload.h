#pragma once

struct DeviceInfo;

struct CountUploadSource {
    const wchar_t* path;
    SRWLOCK* fileLock;
    HANDLE stopEvent;
    // Called while holding fileLock, before removing any acknowledged data.
    bool (*checkpoint)(void* context);
    void* context;
    // Optional deterministic fixture for tests; normal uploads collect their own labels.
    const DeviceInfo* device = nullptr;
    // The test harness selects an unused local port; PDF.exe always uses 8000.
    unsigned short port = 8000;
};

// The application uses the default five-minute interval. The optional shorter
// interval is used only by the native integration test, never by PDF.exe.
HANDLE StartCountUploader(const CountUploadSource* source, DWORD intervalMs = 300000);
bool UploadCountFileOnce(const CountUploadSource& source);
