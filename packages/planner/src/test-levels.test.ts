import { describe, expect, it } from "vitest";
import { intentTestLevelHints, resolveTestLevel } from "./test-levels.js";

const cases = [
["Run core regression checks.",["core"]],
["Run full core regression checks.",["release","core"]],
["不做全量回归测试，只做核心模块回归测试",["core"]],
["执行完整核心模块回归测试",["release","core"]],
["Don't skip release or core tests.",["release","core"]],
["不要省略发布和核心测试",["release","core"]],
["并非不需要发布和核心测试",["release","core"]],
  [
    "Review one currently published product page against this frozen public catalog baseline and an independent current-record GET. No cart, account, order or payment mutations. This is a targeted field-reader regression, not entire store acceptance.",
    []
  ],
  [
    "Run a targeted field-reader regression.",
    []
  ],
  [
    "Run focused component regression checks.",
    []
  ],
  [
    "执行局部表单回归测试",
    []
  ],
  [
    "执行定向字段回归测试",
    []
  ],
  [
    "Run targeted full regression testing.",
    [
      "release"
    ]
  ],
  [
    "Run full regression before release.",
    [
      "release"
    ]
  ],
  [
    "Run regression tests.",
    [
      "release"
    ]
  ],
  [
    "执行全量回归测试",
    [
      "release"
    ]
  ],
  [
    "不要做上线测试，只检查核心链路",
    [
      "core"
    ]
  ],
  [
    "不做冒烟测试，执行上线前回归测试",
    [
      "release"
    ]
  ],
  [
    "无需发布门禁，做快速检查",
    [
      "quick"
    ]
  ],
  [
    "不需要核心测试，只做冒烟",
    [
      "quick"
    ]
  ],
  [
    "Smoke check only; no release regression.",
    [
      "quick"
    ]
  ],
  [
    "Run core tests without a release gate.",
    [
      "core"
    ]
  ],
  [
    "Skip release testing and run smoke checks.",
    [
      "quick"
    ]
  ],
  [
    "Release testing is out of scope; do a quick check.",
    [
      "quick"
    ]
  ],
  [
    "Run quick checks rather than release regression.",
    [
      "quick"
    ]
  ],
  [
    "Do not run release tests. Run core checks.",
    [
      "core"
    ]
  ],
  [
    "Don't do smoke tests; run release regression.",
    [
      "release"
    ]
  ],
  [
    "No release, regression or smoke tests. Check the core path.",
    [
      "core"
    ]
  ],
  [
    "Not only smoke tests but release regression.",
    [
      "release",
      "quick"
    ]
  ],
  [
    "Not just core tests; run release regression.",
    [
      "release",
      "core"
    ]
  ],
  [
    "不要跳过上线回归测试",
    [
      "release"
    ]
  ],
  [
    "不应省略发布测试",
    [
      "release"
    ]
  ],
  [
    "Don't skip release regression.",
    [
      "release"
    ]
  ],
  [
    "Do not omit core tests; run release regression.",
    [
      "release",
      "core"
    ]
  ],
  [
    "Never skip release tests.",
    [
      "release"
    ]
  ],
  [
    "无需支付操作，执行上线完整回归测试",
    [
      "release"
    ]
  ],
  [
    "No payment mutations; run release regression.",
    [
      "release"
    ]
  ],
  [
    "No errors should be visible during release testing.",
    [
      "release"
    ]
  ],
  [
    "不要出现错误，执行上线测试",
    [
      "release"
    ]
  ],
  [
    "Review https://release.example.test/quick/regression?mode=core",
    []
  ],
  [
    "Inspect the productionized scorecard and quicksort page.",
    []
  ],
  [
    "Review release notes with core checks.",
    [
      "release",
      "core"
    ]
  ],
  [
    "快速检查上线功能",
    [
      "release",
      "quick"
    ]
  ]
] as const;

describe("contextual intent intensity", () => {
  it.each(cases)("keeps positive intensity cues for %s", (intent, levels) => {
    expect(intentTestLevelHints(intent)).toEqual(levels);
    expect(resolveTestLevel(intent).resolved).toBe(levels[0] ?? "core");
    expect(resolveTestLevel(intent, "quick")).toMatchObject({ requested: "quick", resolved: "quick", source: "explicit" });
  });
});
