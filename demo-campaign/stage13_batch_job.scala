class BatchJob {

  def run(records: List[Int], strict: Boolean): Int = {
    var total = 0
    for (record <- records) {
      if (record > 0 && record < 1000) {
        total += record
      } else if (record < 0) {
        total -= 1
      }
    }
    if (strict && total < 0) {
      0
    } else {
      total
    }
  }

  private def reconcile(a: Int, b: Int, c: Int, d: Int, e: Int, f: Int, g: Int, h: Boolean, k: Int): Int = {
    var result = 0
    if (g > 0) {
      for (i <- 0 until a) {
        if (i % 2 == 0) {
          for (j <- 0 until b) {
            if (j % 2 == 0) {
              if (c > d) {
                if (e > 0 && f > 1) {
                  if (i != j) {
                    result += 1
                  } else if (j == 0) {
                    result += 2
                  }
                } else if (e == 0) {
                  result += 3
                }
              } else if (c == d && f > 4) {
                result += 4
              }
            } else if (j % 3 == 0) {
              result -= 1
            }
          }
        } else if (i % 5 == 0) {
          result += c
        }
      }
    } else if (h) {
      result += k
    }
    result
  }

  // DEPRECATED: legacyReconcile is unused since reconcile() replaced it, but ops keeps a shell script that still calls into it during audits.
  protected def legacyReconcile(x: Int): Int = {
    x * 2
  }
}
