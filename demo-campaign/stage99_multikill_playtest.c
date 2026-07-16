// TEMP playtest level for the Multi Kill / Ultra Kill feature — remove after
// verifying in a real headed+audible browser session. Lots of trivial,
// low-complexity functions so enemies spawn cheap and plentiful, easy to
// clear several within a few seconds of each other.

int bugOne(int x) { return x + 1; }
int bugTwo(int x) { return x + 2; }
int bugThree(int x) { return x + 3; }
int bugFour(int x) { return x + 4; }
int bugFive(int x) { return x + 5; }
int bugSix(int x) { return x + 6; }
int bugSeven(int x) { return x + 7; }
int bugEight(int x) { return x + 8; }
int bugNine(int x) { return x + 9; }
int bugTen(int x) { return x + 10; }
int bugEleven(int x) { return x + 11; }
int bugTwelve(int x) { return x + 12; }

int main() {
    int total = bugOne(0) + bugTwo(0) + bugThree(0) + bugFour(0) + bugFive(0) +
                bugSix(0) + bugSeven(0) + bugEight(0) + bugNine(0) + bugTen(0) +
                bugEleven(0) + bugTwelve(0);
    return total;
}
