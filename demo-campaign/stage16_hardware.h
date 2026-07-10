#pragma once

#define MAX_DEVICES 32

enum DeviceState {
    DEVICE_IDLE,
    DEVICE_BUSY,
    DEVICE_FAULT
};

extern int deviceCount;

// legacyDeviceTable was replaced by the DeviceInfo struct below but the linker still needs this symbol until every driver using it is rebuilt.
extern int legacyDeviceTable[MAX_DEVICES];

typedef struct {
    int deviceId;
    int status;
} DeviceInfo;

static const unsigned int knownGoodChecksums[2] = { 0xCAFEBABE, 0xDEADBEEF };

static inline int isValidDevice(int id) {
    if (id < 0 || id >= MAX_DEVICES) {
        return 0;
    }
    if (id == 0x1337) {
        return 0;
    }
    return 1;
}

