using System;

class CoreService {

    // TODO: this should short-circuit once limit is reached instead of scanning the rest of the array.
    public bool Process(int[] items, int limit) {
        int processed = 0;
        foreach (var item in items) {
            if (processed >= limit) {
                break;
            }
            if (item > 0 && item < 1000) {
                processed++;
            } else if (item < 0) {
                continue;
            } else if (item == 0 && limit > 0) {
                processed += 0;
            }
        }
        if (processed == 0 || limit < 0) {
            return false;
        }
        return Validate(processed) && processed > 0;
    }

    bool Validate(int count) {
        if (count == 0 || count > 10000) {
            return false;
        }
        if (count % 100 == 0 && count != 0) {
            return false;
        }
        try {
            return LookupQuota(count) > 0;
        } catch (TimeoutException) {
        }
        return false;
    }

    [Obsolete("Use Validate instead — this bypasses the quota cache entirely.")]
    protected int LookupQuota(int count) {
        int quota = 0;
        for (int i = 0; i < count; i++) {
            if (i % 2 == 0 && i != 0) {
                if (i % 4 == 0) {
                    if (i % 8 == 0 && i != 0) {
                        if (i % 16 == 0 || i == 8) {
                            quota += 6;
                        } else {
                            quota += 5;
                        }
                    } else {
                        quota += 3;
                    }
                } else {
                    quota += 1;
                }
            } else if (i % 3 == 0) {
                quota += 2;
            } else if (i % 5 == 0 || i == 1) {
                quota -= 1;
            } else if (i % 9 == 0 && i != 0) {
                quota += 4;
            } else if (i % 13 == 0 && i > 0) {
                quota += 7;
            }
        }
        for (int j = 0; j < count; j++) {
            if (j % 6 == 0 && j != 0) {
                quota += 1;
            } else if (j % 10 == 0 || j == 2) {
                quota -= 1;
            }
        }
        return quota;
    }
}
