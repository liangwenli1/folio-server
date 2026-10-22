// The steps a flow is made of. The desktop app runs them with Playwright, so selectors are Playwright's (CSS, or
// `text=Log in` and the like); inside a loop over elements, `@item` is the current one. Text fields may use
// {{variables}}.
import { z } from 'zod';
import { ApiError } from '../errors.js';

const selector = z.string().trim().min(1).max(500);
const text = z.string().max(5000);
const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/);
const seconds = z.number().min(0).max(3600);

export const Test = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exists'), selector }),
  z.object({ kind: z.literal('contains'), selector, text }),
  z.object({ kind: z.literal('equals'), variable, value: text })
]);

const leaf = [
  z.object({ type: z.literal('open'), url: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('click'), selector }),
  // `slow` types one character at a time with random pauses, as a person would.
  z.object({ type: z.literal('type'), selector, text, slow: z.boolean() }),
  z.object({ type: z.literal('press'), key: z.string().trim().min(1).max(60) }),
  // A pause (`seconds`, or a random time up to `maxSeconds`), or until an element shows or goes (`seconds` is then the limit).
  z.object({ type: z.literal('wait'), until: z.enum(['time', 'visible', 'hidden']), seconds, maxSeconds: seconds.nullable(), selector: selector.nullable() }),
  z.object({ type: z.literal('scroll'), to: z.enum(['element', 'pixels', 'bottom']), selector: selector.nullable(), pixels: z.number().int().min(-100_000).max(100_000).nullable() }),
  // The element's text, or one of its attributes, into a variable (which becomes a column of the results).
  z.object({ type: z.literal('extract'), selector, attribute: z.string().trim().min(1).max(60).nullable(), variable }),
  z.object({ type: z.literal('set'), variable, value: text }),
  z.object({ type: z.literal('screenshot'), selector: selector.nullable() }),
  // JavaScript run in the page; what it returns can go into a variable.
  z.object({ type: z.literal('script'), code: z.string().min(1).max(20_000), variable: variable.nullable() }),
  // Opens a page and decides whether the profile is still signed in: by an element only signed-in visitors see
  // (`present`), or one only signed-out visitors see, like a log-in button (`absent`). Signed out ends the run
  // on that profile and is reported apart from failures.
  z.object({ type: z.literal('signedIn'), url: z.string().trim().min(1).max(2000), mode: z.enum(['present', 'absent']), selector, seconds: z.number().min(1).max(120) })
] as const;

export type Step = z.infer<(typeof leaf)[number]>
  | { type: 'if'; test: z.infer<typeof Test>; then: Step[]; else: Step[] }
  | { type: 'loop'; mode: 'times' | 'each'; times: number | null; selector: string | null; steps: Step[] };

export const Step: z.ZodType<Step> = z.lazy(() => z.discriminatedUnion('type', [
  ...leaf,
  z.object({ type: z.literal('if'), test: Test, then: z.array(Step), else: z.array(Step) }),
  z.object({ type: z.literal('loop'), mode: z.enum(['times', 'each']), times: z.number().int().min(1).max(1000).nullable(), selector: selector.nullable(), steps: z.array(Step) })
])).meta({ id: 'Step' });

export const Steps = z.array(Step).max(300);

const MAX_STEPS = 300, MAX_DEPTH = 4;

// Fields that only some modes use must be there when the mode needs them; the whole flow stays a readable size.
export function checkSteps(steps: Step[], depth = 1): number {
  if (steps.length && depth > MAX_DEPTH) throw new ApiError(400, 'flow_too_deep', `Steps nest up to ${MAX_DEPTH} levels`);
  let n = 0;
  for (const s of steps){
    n++;
    const needs = (ok: boolean) => { if (!ok) throw new ApiError(400, 'validation', `A ${s.type} step is missing a field`); };
    if (s.type === 'wait') needs(s.until === 'time' || !!s.selector);
    if (s.type === 'scroll') needs(s.to === 'bottom' || (s.to === 'element' ? !!s.selector : s.pixels !== null));
    if (s.type === 'loop'){ needs(s.mode === 'times' ? s.times !== null : !!s.selector); n += checkSteps(s.steps, depth + 1); }
    if (s.type === 'if') n += checkSteps(s.then, depth + 1) + checkSteps(s.else, depth + 1);
  }
  if (depth === 1 && n > MAX_STEPS) throw new ApiError(400, 'flow_too_long', `A flow has up to ${MAX_STEPS} steps`);
  return n;
}
