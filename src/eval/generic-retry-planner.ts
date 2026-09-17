import type { Failure } from "../legacy/failure/failure-types.js";
import type { Planner, RecoveryPlan } from "../legacy/recovery/recovery-planner.js";

export class GenericRetryPlanner implements Planner {
  plan(_failure: Failure): RecoveryPlan {
    return {
      action: "retry_tool",
      reason: "不管什么失败，都清空工作区再从头试一次",
      resetWorkspace: true,
    };
  }
}
