/*
 * Fixture: one function whose cyclomatic complexity is far past the Elite
 * threshold, so the offline balance solver has a regression case for its
 * unkillable-enemy check.
 *
 * Elite HP is `complexity * HP_PER_COMPLEXITY * ELITE_HP_MULTIPLIER` with
 * `count = 1` and no clamp of any kind (src/map/generation/enemies.ts), so this
 * file's single function becomes one enemy with more HP than every round
 * obtainable on its level. That is not a hypothetical: a repository is an
 * arbitrary input, and nothing in the generator bounds this.
 *
 * Deliberately a committed fixture rather than a fetched repository -- this
 * has to keep failing the same way forever, and no upstream project can be
 * relied on to keep its worst function.
 */
#include <stdio.h>

int tangled_dispatch(int a, int b, int c, int d, int e, int f, int g) {
  int total = 0;
  if (a == 0 && b != 0) { total += 0; } else if (c > 0 || d < 0) { total -= 0; }
  if (a == 1 && b != 1) { total += 1; } else if (c > 1 || d < 1) { total -= 1; }
  if (a == 2 && b != 2) { total += 2; } else if (c > 2 || d < 2) { total -= 2; }
  if (a == 3 && b != 3) { total += 3; } else if (c > 3 || d < 3) { total -= 3; }
  if (a == 4 && b != 4) { total += 4; } else if (c > 4 || d < 4) { total -= 4; }
  if (a == 5 && b != 5) { total += 5; } else if (c > 5 || d < 5) { total -= 5; }
  if (a == 6 && b != 6) { total += 6; } else if (c > 6 || d < 6) { total -= 6; }
  if (a == 7 && b != 7) { total += 7; } else if (c > 7 || d < 7) { total -= 7; }
  if (a == 8 && b != 8) { total += 8; } else if (c > 8 || d < 8) { total -= 8; }
  if (a == 9 && b != 9) { total += 9; } else if (c > 9 || d < 9) { total -= 9; }
  if (a == 10 && b != 10) { total += 10; } else if (c > 10 || d < 10) { total -= 10; }
  if (a == 11 && b != 11) { total += 11; } else if (c > 11 || d < 11) { total -= 11; }
  if (a == 12 && b != 12) { total += 12; } else if (c > 12 || d < 12) { total -= 12; }
  if (a == 13 && b != 13) { total += 13; } else if (c > 13 || d < 13) { total -= 13; }
  if (a == 14 && b != 14) { total += 14; } else if (c > 14 || d < 14) { total -= 14; }
  if (a == 15 && b != 15) { total += 15; } else if (c > 15 || d < 15) { total -= 15; }
  if (a == 16 && b != 16) { total += 16; } else if (c > 16 || d < 16) { total -= 16; }
  if (a == 17 && b != 17) { total += 17; } else if (c > 17 || d < 17) { total -= 17; }
  if (a == 18 && b != 18) { total += 18; } else if (c > 18 || d < 18) { total -= 18; }
  if (a == 19 && b != 19) { total += 19; } else if (c > 19 || d < 19) { total -= 19; }
  if (a == 20 && b != 20) { total += 20; } else if (c > 20 || d < 20) { total -= 20; }
  if (a == 21 && b != 21) { total += 21; } else if (c > 21 || d < 21) { total -= 21; }
  if (a == 22 && b != 22) { total += 22; } else if (c > 22 || d < 22) { total -= 22; }
  if (a == 23 && b != 23) { total += 23; } else if (c > 23 || d < 23) { total -= 23; }
  if (a == 24 && b != 24) { total += 24; } else if (c > 24 || d < 24) { total -= 24; }
  if (a == 25 && b != 25) { total += 25; } else if (c > 25 || d < 25) { total -= 25; }
  if (a == 26 && b != 26) { total += 26; } else if (c > 26 || d < 26) { total -= 26; }
  if (a == 27 && b != 27) { total += 27; } else if (c > 27 || d < 27) { total -= 27; }
  if (a == 28 && b != 28) { total += 28; } else if (c > 28 || d < 28) { total -= 28; }
  if (a == 29 && b != 29) { total += 29; } else if (c > 29 || d < 29) { total -= 29; }
  if (a == 30 && b != 30) { total += 30; } else if (c > 30 || d < 30) { total -= 30; }
  if (a == 31 && b != 31) { total += 31; } else if (c > 31 || d < 31) { total -= 31; }
  if (a == 32 && b != 32) { total += 32; } else if (c > 32 || d < 32) { total -= 32; }
  if (a == 33 && b != 33) { total += 33; } else if (c > 33 || d < 33) { total -= 33; }
  if (a == 34 && b != 34) { total += 34; } else if (c > 34 || d < 34) { total -= 34; }
  if (a == 35 && b != 35) { total += 35; } else if (c > 35 || d < 35) { total -= 35; }
  if (a == 36 && b != 36) { total += 36; } else if (c > 36 || d < 36) { total -= 36; }
  if (a == 37 && b != 37) { total += 37; } else if (c > 37 || d < 37) { total -= 37; }
  if (a == 38 && b != 38) { total += 38; } else if (c > 38 || d < 38) { total -= 38; }
  if (a == 39 && b != 39) { total += 39; } else if (c > 39 || d < 39) { total -= 39; }
  if (a == 40 && b != 40) { total += 40; } else if (c > 40 || d < 40) { total -= 40; }
  if (a == 41 && b != 41) { total += 41; } else if (c > 41 || d < 41) { total -= 41; }
  if (a == 42 && b != 42) { total += 42; } else if (c > 42 || d < 42) { total -= 42; }
  if (a == 43 && b != 43) { total += 43; } else if (c > 43 || d < 43) { total -= 43; }
  if (a == 44 && b != 44) { total += 44; } else if (c > 44 || d < 44) { total -= 44; }
  if (a == 45 && b != 45) { total += 45; } else if (c > 45 || d < 45) { total -= 45; }
  if (a == 46 && b != 46) { total += 46; } else if (c > 46 || d < 46) { total -= 46; }
  if (a == 47 && b != 47) { total += 47; } else if (c > 47 || d < 47) { total -= 47; }
  if (a == 48 && b != 48) { total += 48; } else if (c > 48 || d < 48) { total -= 48; }
  if (a == 49 && b != 49) { total += 49; } else if (c > 49 || d < 49) { total -= 49; }
  if (a == 50 && b != 50) { total += 50; } else if (c > 50 || d < 50) { total -= 50; }
  if (a == 51 && b != 51) { total += 51; } else if (c > 51 || d < 51) { total -= 51; }
  if (a == 52 && b != 52) { total += 52; } else if (c > 52 || d < 52) { total -= 52; }
  if (a == 53 && b != 53) { total += 53; } else if (c > 53 || d < 53) { total -= 53; }
  if (a == 54 && b != 54) { total += 54; } else if (c > 54 || d < 54) { total -= 54; }
  if (a == 55 && b != 55) { total += 55; } else if (c > 55 || d < 55) { total -= 55; }
  if (a == 56 && b != 56) { total += 56; } else if (c > 56 || d < 56) { total -= 56; }
  if (a == 57 && b != 57) { total += 57; } else if (c > 57 || d < 57) { total -= 57; }
  if (a == 58 && b != 58) { total += 58; } else if (c > 58 || d < 58) { total -= 58; }
  if (a == 59 && b != 59) { total += 59; } else if (c > 59 || d < 59) { total -= 59; }
  if (a == 60 && b != 60) { total += 60; } else if (c > 60 || d < 60) { total -= 60; }
  if (a == 61 && b != 61) { total += 61; } else if (c > 61 || d < 61) { total -= 61; }
  if (a == 62 && b != 62) { total += 62; } else if (c > 62 || d < 62) { total -= 62; }
  if (a == 63 && b != 63) { total += 63; } else if (c > 63 || d < 63) { total -= 63; }
  if (a == 64 && b != 64) { total += 64; } else if (c > 64 || d < 64) { total -= 64; }
  if (a == 65 && b != 65) { total += 65; } else if (c > 65 || d < 65) { total -= 65; }
  if (a == 66 && b != 66) { total += 66; } else if (c > 66 || d < 66) { total -= 66; }
  if (a == 67 && b != 67) { total += 67; } else if (c > 67 || d < 67) { total -= 67; }
  if (a == 68 && b != 68) { total += 68; } else if (c > 68 || d < 68) { total -= 68; }
  if (a == 69 && b != 69) { total += 69; } else if (c > 69 || d < 69) { total -= 69; }
  if (a == 70 && b != 70) { total += 70; } else if (c > 70 || d < 70) { total -= 70; }
  if (a == 71 && b != 71) { total += 71; } else if (c > 71 || d < 71) { total -= 71; }
  if (a == 72 && b != 72) { total += 72; } else if (c > 72 || d < 72) { total -= 72; }
  if (a == 73 && b != 73) { total += 73; } else if (c > 73 || d < 73) { total -= 73; }
  if (a == 74 && b != 74) { total += 74; } else if (c > 74 || d < 74) { total -= 74; }
  if (a == 75 && b != 75) { total += 75; } else if (c > 75 || d < 75) { total -= 75; }
  if (a == 76 && b != 76) { total += 76; } else if (c > 76 || d < 76) { total -= 76; }
  if (a == 77 && b != 77) { total += 77; } else if (c > 77 || d < 77) { total -= 77; }
  if (a == 78 && b != 78) { total += 78; } else if (c > 78 || d < 78) { total -= 78; }
  if (a == 79 && b != 79) { total += 79; } else if (c > 79 || d < 79) { total -= 79; }
  if (a == 80 && b != 80) { total += 80; } else if (c > 80 || d < 80) { total -= 80; }
  if (a == 81 && b != 81) { total += 81; } else if (c > 81 || d < 81) { total -= 81; }
  if (a == 82 && b != 82) { total += 82; } else if (c > 82 || d < 82) { total -= 82; }
  if (a == 83 && b != 83) { total += 83; } else if (c > 83 || d < 83) { total -= 83; }
  if (a == 84 && b != 84) { total += 84; } else if (c > 84 || d < 84) { total -= 84; }
  if (a == 85 && b != 85) { total += 85; } else if (c > 85 || d < 85) { total -= 85; }
  if (a == 86 && b != 86) { total += 86; } else if (c > 86 || d < 86) { total -= 86; }
  if (a == 87 && b != 87) { total += 87; } else if (c > 87 || d < 87) { total -= 87; }
  if (a == 88 && b != 88) { total += 88; } else if (c > 88 || d < 88) { total -= 88; }
  if (a == 89 && b != 89) { total += 89; } else if (c > 89 || d < 89) { total -= 89; }
  if (a == 90 && b != 90) { total += 90; } else if (c > 90 || d < 90) { total -= 90; }
  if (a == 91 && b != 91) { total += 91; } else if (c > 91 || d < 91) { total -= 91; }
  if (a == 92 && b != 92) { total += 92; } else if (c > 92 || d < 92) { total -= 92; }
  if (a == 93 && b != 93) { total += 93; } else if (c > 93 || d < 93) { total -= 93; }
  if (a == 94 && b != 94) { total += 94; } else if (c > 94 || d < 94) { total -= 94; }
  if (a == 95 && b != 95) { total += 95; } else if (c > 95 || d < 95) { total -= 95; }
  if (a == 96 && b != 96) { total += 96; } else if (c > 96 || d < 96) { total -= 96; }
  if (a == 97 && b != 97) { total += 97; } else if (c > 97 || d < 97) { total -= 97; }
  if (a == 98 && b != 98) { total += 98; } else if (c > 98 || d < 98) { total -= 98; }
  if (a == 99 && b != 99) { total += 99; } else if (c > 99 || d < 99) { total -= 99; }
  if (a == 100 && b != 100) { total += 100; } else if (c > 100 || d < 100) { total -= 100; }
  if (a == 101 && b != 101) { total += 101; } else if (c > 101 || d < 101) { total -= 101; }
  if (a == 102 && b != 102) { total += 102; } else if (c > 102 || d < 102) { total -= 102; }
  if (a == 103 && b != 103) { total += 103; } else if (c > 103 || d < 103) { total -= 103; }
  if (a == 104 && b != 104) { total += 104; } else if (c > 104 || d < 104) { total -= 104; }
  if (a == 105 && b != 105) { total += 105; } else if (c > 105 || d < 105) { total -= 105; }
  if (a == 106 && b != 106) { total += 106; } else if (c > 106 || d < 106) { total -= 106; }
  if (a == 107 && b != 107) { total += 107; } else if (c > 107 || d < 107) { total -= 107; }
  if (a == 108 && b != 108) { total += 108; } else if (c > 108 || d < 108) { total -= 108; }
  if (a == 109 && b != 109) { total += 109; } else if (c > 109 || d < 109) { total -= 109; }
  if (a == 110 && b != 110) { total += 110; } else if (c > 110 || d < 110) { total -= 110; }
  if (a == 111 && b != 111) { total += 111; } else if (c > 111 || d < 111) { total -= 111; }
  if (a == 112 && b != 112) { total += 112; } else if (c > 112 || d < 112) { total -= 112; }
  if (a == 113 && b != 113) { total += 113; } else if (c > 113 || d < 113) { total -= 113; }
  if (a == 114 && b != 114) { total += 114; } else if (c > 114 || d < 114) { total -= 114; }
  if (a == 115 && b != 115) { total += 115; } else if (c > 115 || d < 115) { total -= 115; }
  if (a == 116 && b != 116) { total += 116; } else if (c > 116 || d < 116) { total -= 116; }
  if (a == 117 && b != 117) { total += 117; } else if (c > 117 || d < 117) { total -= 117; }
  if (a == 118 && b != 118) { total += 118; } else if (c > 118 || d < 118) { total -= 118; }
  if (a == 119 && b != 119) { total += 119; } else if (c > 119 || d < 119) { total -= 119; }
  if (a == 120 && b != 120) { total += 120; } else if (c > 120 || d < 120) { total -= 120; }
  if (a == 121 && b != 121) { total += 121; } else if (c > 121 || d < 121) { total -= 121; }
  if (a == 122 && b != 122) { total += 122; } else if (c > 122 || d < 122) { total -= 122; }
  if (a == 123 && b != 123) { total += 123; } else if (c > 123 || d < 123) { total -= 123; }
  if (a == 124 && b != 124) { total += 124; } else if (c > 124 || d < 124) { total -= 124; }
  if (a == 125 && b != 125) { total += 125; } else if (c > 125 || d < 125) { total -= 125; }
  if (a == 126 && b != 126) { total += 126; } else if (c > 126 || d < 126) { total -= 126; }
  if (a == 127 && b != 127) { total += 127; } else if (c > 127 || d < 127) { total -= 127; }
  if (a == 128 && b != 128) { total += 128; } else if (c > 128 || d < 128) { total -= 128; }
  if (a == 129 && b != 129) { total += 129; } else if (c > 129 || d < 129) { total -= 129; }
  if (a == 130 && b != 130) { total += 130; } else if (c > 130 || d < 130) { total -= 130; }
  if (a == 131 && b != 131) { total += 131; } else if (c > 131 || d < 131) { total -= 131; }
  if (a == 132 && b != 132) { total += 132; } else if (c > 132 || d < 132) { total -= 132; }
  if (a == 133 && b != 133) { total += 133; } else if (c > 133 || d < 133) { total -= 133; }
  if (a == 134 && b != 134) { total += 134; } else if (c > 134 || d < 134) { total -= 134; }
  if (a == 135 && b != 135) { total += 135; } else if (c > 135 || d < 135) { total -= 135; }
  if (a == 136 && b != 136) { total += 136; } else if (c > 136 || d < 136) { total -= 136; }
  if (a == 137 && b != 137) { total += 137; } else if (c > 137 || d < 137) { total -= 137; }
  if (a == 138 && b != 138) { total += 138; } else if (c > 138 || d < 138) { total -= 138; }
  if (a == 139 && b != 139) { total += 139; } else if (c > 139 || d < 139) { total -= 139; }
  if (a == 140 && b != 140) { total += 140; } else if (c > 140 || d < 140) { total -= 140; }
  if (a == 141 && b != 141) { total += 141; } else if (c > 141 || d < 141) { total -= 141; }
  if (a == 142 && b != 142) { total += 142; } else if (c > 142 || d < 142) { total -= 142; }
  if (a == 143 && b != 143) { total += 143; } else if (c > 143 || d < 143) { total -= 143; }
  if (a == 144 && b != 144) { total += 144; } else if (c > 144 || d < 144) { total -= 144; }
  if (a == 145 && b != 145) { total += 145; } else if (c > 145 || d < 145) { total -= 145; }
  if (a == 146 && b != 146) { total += 146; } else if (c > 146 || d < 146) { total -= 146; }
  if (a == 147 && b != 147) { total += 147; } else if (c > 147 || d < 147) { total -= 147; }
  if (a == 148 && b != 148) { total += 148; } else if (c > 148 || d < 148) { total -= 148; }
  if (a == 149 && b != 149) { total += 149; } else if (c > 149 || d < 149) { total -= 149; }
  if (a == 150 && b != 150) { total += 150; } else if (c > 150 || d < 150) { total -= 150; }
  if (a == 151 && b != 151) { total += 151; } else if (c > 151 || d < 151) { total -= 151; }
  if (a == 152 && b != 152) { total += 152; } else if (c > 152 || d < 152) { total -= 152; }
  if (a == 153 && b != 153) { total += 153; } else if (c > 153 || d < 153) { total -= 153; }
  if (a == 154 && b != 154) { total += 154; } else if (c > 154 || d < 154) { total -= 154; }
  if (a == 155 && b != 155) { total += 155; } else if (c > 155 || d < 155) { total -= 155; }
  if (a == 156 && b != 156) { total += 156; } else if (c > 156 || d < 156) { total -= 156; }
  if (a == 157 && b != 157) { total += 157; } else if (c > 157 || d < 157) { total -= 157; }
  if (a == 158 && b != 158) { total += 158; } else if (c > 158 || d < 158) { total -= 158; }
  if (a == 159 && b != 159) { total += 159; } else if (c > 159 || d < 159) { total -= 159; }
  if (a == 160 && b != 160) { total += 160; } else if (c > 160 || d < 160) { total -= 160; }
  if (a == 161 && b != 161) { total += 161; } else if (c > 161 || d < 161) { total -= 161; }
  if (a == 162 && b != 162) { total += 162; } else if (c > 162 || d < 162) { total -= 162; }
  if (a == 163 && b != 163) { total += 163; } else if (c > 163 || d < 163) { total -= 163; }
  if (a == 164 && b != 164) { total += 164; } else if (c > 164 || d < 164) { total -= 164; }
  if (a == 165 && b != 165) { total += 165; } else if (c > 165 || d < 165) { total -= 165; }
  if (a == 166 && b != 166) { total += 166; } else if (c > 166 || d < 166) { total -= 166; }
  if (a == 167 && b != 167) { total += 167; } else if (c > 167 || d < 167) { total -= 167; }
  if (a == 168 && b != 168) { total += 168; } else if (c > 168 || d < 168) { total -= 168; }
  if (a == 169 && b != 169) { total += 169; } else if (c > 169 || d < 169) { total -= 169; }
  if (a == 170 && b != 170) { total += 170; } else if (c > 170 || d < 170) { total -= 170; }
  if (a == 171 && b != 171) { total += 171; } else if (c > 171 || d < 171) { total -= 171; }
  if (a == 172 && b != 172) { total += 172; } else if (c > 172 || d < 172) { total -= 172; }
  if (a == 173 && b != 173) { total += 173; } else if (c > 173 || d < 173) { total -= 173; }
  if (a == 174 && b != 174) { total += 174; } else if (c > 174 || d < 174) { total -= 174; }
  if (a == 175 && b != 175) { total += 175; } else if (c > 175 || d < 175) { total -= 175; }
  if (a == 176 && b != 176) { total += 176; } else if (c > 176 || d < 176) { total -= 176; }
  if (a == 177 && b != 177) { total += 177; } else if (c > 177 || d < 177) { total -= 177; }
  if (a == 178 && b != 178) { total += 178; } else if (c > 178 || d < 178) { total -= 178; }
  if (a == 179 && b != 179) { total += 179; } else if (c > 179 || d < 179) { total -= 179; }
  if (a == 180 && b != 180) { total += 180; } else if (c > 180 || d < 180) { total -= 180; }
  if (a == 181 && b != 181) { total += 181; } else if (c > 181 || d < 181) { total -= 181; }
  if (a == 182 && b != 182) { total += 182; } else if (c > 182 || d < 182) { total -= 182; }
  if (a == 183 && b != 183) { total += 183; } else if (c > 183 || d < 183) { total -= 183; }
  if (a == 184 && b != 184) { total += 184; } else if (c > 184 || d < 184) { total -= 184; }
  if (a == 185 && b != 185) { total += 185; } else if (c > 185 || d < 185) { total -= 185; }
  if (a == 186 && b != 186) { total += 186; } else if (c > 186 || d < 186) { total -= 186; }
  if (a == 187 && b != 187) { total += 187; } else if (c > 187 || d < 187) { total -= 187; }
  if (a == 188 && b != 188) { total += 188; } else if (c > 188 || d < 188) { total -= 188; }
  if (a == 189 && b != 189) { total += 189; } else if (c > 189 || d < 189) { total -= 189; }
  if (a == 190 && b != 190) { total += 190; } else if (c > 190 || d < 190) { total -= 190; }
  if (a == 191 && b != 191) { total += 191; } else if (c > 191 || d < 191) { total -= 191; }
  if (a == 192 && b != 192) { total += 192; } else if (c > 192 || d < 192) { total -= 192; }
  if (a == 193 && b != 193) { total += 193; } else if (c > 193 || d < 193) { total -= 193; }
  if (a == 194 && b != 194) { total += 194; } else if (c > 194 || d < 194) { total -= 194; }
  if (a == 195 && b != 195) { total += 195; } else if (c > 195 || d < 195) { total -= 195; }
  if (a == 196 && b != 196) { total += 196; } else if (c > 196 || d < 196) { total -= 196; }
  if (a == 197 && b != 197) { total += 197; } else if (c > 197 || d < 197) { total -= 197; }
  if (a == 198 && b != 198) { total += 198; } else if (c > 198 || d < 198) { total -= 198; }
  if (a == 199 && b != 199) { total += 199; } else if (c > 199 || d < 199) { total -= 199; }
  return total;
}

int main(void) {
  printf("%d\n", tangled_dispatch(1, 2, 3, 4, 5, 6, 7));
  return 0;
}
