/** Per-delegation guard profile; buildGuardPolicy accepts it optionally. */
export interface GuardProfile {
  kind: "reader" | "producer";
  budget: number;
  cumulative: number;
}
