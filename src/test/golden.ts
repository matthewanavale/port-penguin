// D9: the shape of a golden file, and the reason codes that allow a re-recorded
// step to differ from its run-1 copy in src/test/golden-run1/.

/** The reasons a re-recorded step may differ from run 1 (D9 (4)). */
export const REASON_CODES = ["R1", "R2", "R3", "R4", "R5", "R6"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** What one command line gives back. */
export interface StepResult {
  /** Plain text of the new terminal lines, without the echoed command. */
  text: string;
  /** True when the command cleared the screen. `text` is then only what came after. */
  cleared: boolean;
  /** `S.lastCode` after the line. */
  code: number;
  /** `S.cwd` after the line. */
  cwd: string;
  /** `S.cur` (the task index) after the line. */
  cur: number;
}

/** Fields of a step that explain a change from run 1. Written in scripts.ts, copied by the recorder. */
export interface StepNote {
  /** Reason codes with a short text, for example "R1 date format". Starts with a code from REASON_CODES. */
  reason?: string;
  /** R3 only: the index of the run-1 step this step replaces. */
  replaces?: number;
}

/** One recorded step of a golden file. */
export type GoldenStep =
  | ({ input: string } & StepResult & StepNote)
  | ({ advanceMs: number } & StepNote)
  | ({
      tab: string;
      cursor: number;
      value: string;
      newCursor: number;
      listing: string | null;
    } & StepNote);

/** The content of src/test/golden/<script>.json and src/test/golden-run1/<script>.json. */
export interface Golden {
  script: string;
  steps: GoldenStep[];
  /** The raw JSON string saved under port-penguin-v2 after the last step. */
  save: string | null;
}
