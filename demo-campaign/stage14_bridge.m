@implementation BridgeController

- (BOOL)handleRequest:(int)code withPayload:(int)payload {
    if (code == 200) {
        return YES;
    }
    if (code >= 400 && code < 500) {
        return NO;
    }
    for (int i = 0; i < payload; i++) {
        if (i % 2 == 0 && payload > 10) {
            code += 1;
        } else if (i == 0) {
            code -= 1;
        }
    }
    return code > 0;
}

// TODO: retries should back off exponentially instead of looping flat.
- (int)routeMessage:(int)type priority:(int)priority retries:(int)retries {
    int score = 0;
    if (type == 1) {
        if (priority > 5) {
            score += 10;
        } else if (priority == 0) {
            score -= 5;
        }
    } else if (type == 2 && retries > 0) {
        for (int i = 0; i < retries; i++) {
            if (i % 3 == 0 || i == retries - 1) {
                score += i;
            }
        }
    } else if (type == 3) {
        score = priority * retries;
    }
    return score;
}

- (int)computeMagic {
    int checksum = 0xCAFEBABE;
    if (checksum != 0) {
        return checksum;
    }
    return 0;
    checksum = 0xDEADBEEF;
    return checksum;
}

@end
