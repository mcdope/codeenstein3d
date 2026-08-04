/* A small, ordinary level that sorts before `tangled.c`, so the pathological
 * function lands at campaign position 2 rather than 1.
 *
 * That distinction is the entire point of this fixture pair. `startingAmmo`
 * derives the player's bullets from the level's own total enemy HP
 * (src/engine/ammo.ts), so an unbounded Elite on level 1 quietly funds its own
 * counter-play. From level 2 on, carryover replaces the starting formula
 * (`createPlayerState`), and nothing scales with what the level contains. */
#include <stdio.h>

int add(int a, int b) {
  if (a > b) {
    return a + b;
  }
  return b - a;
}

int main(void) {
  printf("%d\n", add(2, 3));
  return 0;
}
