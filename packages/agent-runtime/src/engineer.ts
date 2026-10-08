import {
  confidentChoice,
  DEFAULT_STATION_MAX_RETRIES,
  REVISION_ACTIONS,
  shouldNotifyDispatcher,
  STATION_FAILURE_ACTIONS,
  type GateDecision,
  type Issue,
  type ReviewFeedback,
  type RevisionAction,
  type Station,
  type StationFailureAction,
  type Train,
} from "@terminus/domain"
import type { DecisionAnswer, DecisionQuestion } from "@terminus/protocol"
import type { DecisionModel } from "./decision-model"

/** A Station as the decision model sees it: its goal and retry budget, no diffs. */
export interface StationBrief {
  id: string
  name: string
  goal: string
  acceptanceCriteria: string[]
  /** Times the Conductor has returned this Station's work, ever. */
  revisionCount: number
  /** Failed runs already started again. */
  runRetries: number
  /** Automatic retries left before the hard cap blocks the Train. */
  retriesRemaining: number
}

export function stationBrief(
  station: Station,
  maxRetries = DEFAULT_STATION_MAX_RETRIES
): StationBrief {
  return {
    id: station.id,
    name: station.name,
    goal: station.manifest.goal,
    acceptanceCriteria: station.manifest.acceptanceCriteria,
    revisionCount: station.revisionCount,
    runRetries: station.runRetries ?? 0,
    retriesRemaining: Math.max(
      0,
      maxRetries - (station.retryCount ?? station.revisionCount)
    ),
  }
}

export interface StationFailureSituation {
  station: StationBrief
  /** What the failed run reported, including the phase it stopped in. */
  issues: Issue[]
}

export interface RevisionSituation {
  station: StationBrief
  /** The Conductor's feedback on the work it is returning now. */
  feedback: ReviewFeedback
  /** Its feedback on the previous return, if there was one. */
  previousFeedback: ReviewFeedback | null
}

/** The Train at a gate, for deciding whether the Dispatcher should hear of it. */
export interface NoticeSituation {
  train: Train
  gate: GateDecision
}

/**
 * The questions the hard rules leave open (docs/technology-architecture.md,
 * "Clef for Ambiguous Decisions"). Each answer option is an Engineer action.
 */
export const ENGINEER_QUESTIONS = {
  station_failure: {
    type: "choice",
    instructions:
      "A Station run in `station` failed with `issues` before producing work for review. Each issue's detail names the phase the run stopped in. What should the Engineer do?",
    criteria: {
      retry:
        "Run it again now: the failure looks transient or flaky, such as a sandbox, network, or harness hiccup",
      wait: "Run it again after a pause: the failure looks like an outage or rate limit that needs time to clear",
      escalate:
        "Stop and ask the user: the failure looks persistent, such as broken project setup, invalid configuration, or work the agent cannot do",
    },
  },
  revision: {
    type: "choice",
    instructions:
      "The Conductor returned the work of `station` with `feedback`. `previousFeedback` is its feedback on the previous return, if any. Is another automatic revision likely to produce acceptable work?",
    criteria: {
      revise:
        "Revise again: the feedback is specific and actionable, and the work is making progress",
      escalate:
        "Stop and ask the user: the same problems keep coming back, the work is regressing, or the feedback asks for something the Station Agent cannot resolve alone",
    },
  },
  notify_dispatcher: {
    type: "noul",
    instructions:
      "Should the Dispatcher be told about this Train's situation? Routine movement, such as clearing a normal departure or waiting for a Station that isn't ready, needs no report.",
  },
} satisfies Record<string, DecisionQuestion>

/** An Engineer answer, and how sure the model was. */
export interface EngineerAdvice<T> {
  value: T
  /** Null when the model gave no answer and the deterministic default stood. */
  confidence: number | null
  /** Why the model gave no answer. */
  error?: string
}

/**
 * The Engineer's decision model for choices the hard rules don't settle. It
 * is asked only after the hard gates clear, and every answer falls back to
 * the deterministic default unless the model is confident.
 */
export interface EngineerAdvisor {
  readonly model: string
  /** Defaults to escalating, which blocks the Train as before. */
  stationFailure(
    situation: StationFailureSituation
  ): Promise<EngineerAdvice<StationFailureAction>>
  /** Defaults to revising, up to the hard retry cap. */
  revision(
    situation: RevisionSituation
  ): Promise<EngineerAdvice<RevisionAction>>
  /** Defaults to notifying. */
  notifyDispatcher(situation: NoticeSituation): Promise<EngineerAdvice<boolean>>
}

export class ModelEngineer implements EngineerAdvisor {
  readonly model: string
  private readonly decisions: DecisionModel
  private readonly threshold?: number
  constructor(model: string, decisions: DecisionModel, threshold?: number) {
    this.model = model
    this.decisions = decisions
    this.threshold = threshold
  }

  stationFailure(
    situation: StationFailureSituation
  ): Promise<EngineerAdvice<StationFailureAction>> {
    return this.choose(
      situation,
      "station_failure",
      STATION_FAILURE_ACTIONS,
      "escalate"
    )
  }

  revision(
    situation: RevisionSituation
  ): Promise<EngineerAdvice<RevisionAction>> {
    return this.choose(situation, "revision", REVISION_ACTIONS, "revise")
  }

  async notifyDispatcher(
    situation: NoticeSituation
  ): Promise<EngineerAdvice<boolean>> {
    try {
      const answer = await this.ask(situation, "notify_dispatcher")
      if (answer.type !== "noul") throw new Error("Expected a yes/no answer")
      return {
        value: shouldNotifyDispatcher(answer.noul, this.threshold),
        confidence: Math.max(answer.noul, 1 - answer.noul),
      }
    } catch (error) {
      return {
        value: shouldNotifyDispatcher(null),
        confidence: null,
        error: message(error),
      }
    }
  }

  private async choose<T extends string>(
    situation: unknown,
    id: "station_failure" | "revision",
    options: readonly T[],
    fallback: T
  ): Promise<EngineerAdvice<T>> {
    try {
      const answer = await this.ask(situation, id)
      if (answer.type !== "choice") throw new Error("Expected a choice")
      return {
        value: confidentChoice(
          answer.probabilities as Partial<Record<T, number>>,
          options,
          fallback,
          this.threshold
        ),
        confidence: answer.confidence,
      }
    } catch (error) {
      return { value: fallback, confidence: null, error: message(error) }
    }
  }

  private async ask(
    situation: unknown,
    id: keyof typeof ENGINEER_QUESTIONS
  ): Promise<DecisionAnswer> {
    const answers = await this.decisions.decide({
      role: "engineer",
      state: situation,
      questions: { [id]: ENGINEER_QUESTIONS[id] },
    })
    return answers[id]!
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
