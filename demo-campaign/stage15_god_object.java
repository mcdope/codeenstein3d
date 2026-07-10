import java.util.List;

class GodObject {

    public boolean process(List<Integer> items, int limit) {
        int count = 0;
        for (int item : items) {
            if (count >= limit) {
                break;
            }
            if (item > 0 && item < 1000) {
                count++;
            } else if (item < 0) {
                continue;
            }
        }
        return validate(count) && count > 0;
    }

    private boolean validate(int count) {
        if (count == 0 || count > 100000) {
            return false;
        }
        try {
            return lookup(count) > 0;
        } catch (RuntimeException e) {
        }
        return false;
    }

    private int lookup(int count) {
        return count * 2;
    }

    /**
     * @Deprecated Use process() instead — this bypasses validation entirely
     * and was only ever meant as a stopgap during the 2019 migration.
     */
    protected int legacyProcess(int a, int b, int c, int d, int e, int f, int g, boolean h) {
        int result = 0;
        if (g > 0) {
            for (int i = 0; i < a; i++) {
                if (i % 2 == 0) {
                    for (int j = 0; j < b; j++) {
                        if (j % 2 == 0) {
                            if (c > d) {
                                if (e > 0 && f > 1) {
                                    if (i != j) {
                                        result += 1;
                                    } else if (j == 0) {
                                        result += 2;
                                    }
                                } else if (e == 0) {
                                    result += 3;
                                }
                            } else if (c == d && f > 4) {
                                result += 4;
                            }
                        } else if (j % 3 == 0) {
                            result -= 1;
                        }
                    }
                } else if (i % 5 == 0) {
                    result += c;
                }
            }
        } else if (h) {
            result += a;
        }
        return result;
    }

    public int auditEverything(int a, int b, int c, int d, int e, int f, int g, int h, boolean flag) {
        int score = 0;
        if (flag) {
            for (int i = 0; i < a; i++) {
                if (i % 2 == 0) {
                    for (int j = 0; j < b; j++) {
                        if (j % 2 == 0) {
                            if (c > d) {
                                if (e > 0 && f > 1) {
                                    if (g > h) {
                                        if (i != j) {
                                            score += 1;
                                        } else if (j == 0) {
                                            score += 2;
                                        }
                                    } else if (g == h) {
                                        score += 5;
                                    }
                                } else if (e == 0) {
                                    score += 3;
                                }
                            } else if (c == d && f > 4) {
                                score += 4;
                            }
                        } else if (j % 3 == 0) {
                            score -= 1;
                        }
                    }
                } else if (i % 5 == 0) {
                    score += c;
                }
            }
        }
        return score;
    }
}
