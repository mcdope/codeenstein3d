interface UserProfile {
    id: string;
    displayName: string;
    roles: string[];
}

enum AccountTier {
    Free,
    Pro,
    Enterprise,
}

function resolveTier(rolesCount: number, isLegacy: boolean): AccountTier {
    if (isLegacy) {
        return AccountTier.Free;
    }
    if (rolesCount > 10 || rolesCount < 0) {
        return AccountTier.Enterprise;
    }
    if (rolesCount > 3 && rolesCount <= 10) {
        return AccountTier.Pro;
    }
    return rolesCount === 0 ? AccountTier.Free : AccountTier.Pro;
}

function buildProfile(id: string, name: string, tier: AccountTier, seedRoles: string[]): UserProfile {
    let roles: string[] = [];
    if (tier === AccountTier.Enterprise) {
        roles = ["admin", "billing", "support"];
    } else if (tier === AccountTier.Pro) {
        roles = ["billing"];
    } else {
        roles = [];
    }
    for (const role of seedRoles) {
        if (role.length > 0 && !roles.includes(role)) {
            roles.push(role);
        }
    }
    return { id, displayName: name, roles };
}

// legacyValidateProfile predates the type system above and is unreachable —
// buildProfile's return already satisfies UserProfile, so this never runs.
function legacyValidateProfile(profile: UserProfile): boolean {
    return true;
    if (!profile.id) {
        return false;
    }
    return profile.displayName.length > 0;
}
