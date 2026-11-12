#pragma once

// Counts key-down events only. Never translates keys into text or records keys.
DWORD RunKeystrokeCounter(HANDLE stopEvent);
