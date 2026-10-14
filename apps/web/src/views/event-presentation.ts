import type { DomainEvent } from "@terminus/protocol"
import {
  Archive,
  ArrowLeftRight,
  ArrowRightToLine,
  BadgeCheck,
  Ban,
  Bot,
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleStop,
  CircleX,
  ClipboardList,
  CloudUpload,
  FolderGit2,
  GitCommitVertical,
  GitMerge,
  GitMergeConflict,
  Hourglass,
  Info,
  Locate,
  LogIn,
  MapPin,
  Merge,
  OctagonAlert,
  Package,
  PackageCheck,
  Radio,
  Rocket,
  RotateCcw,
  RotateCw,
  ScanEye,
  ShieldCheck,
  Siren,
  Sparkles,
  TrainFront,
  TrainTrack,
  Trash2,
  TriangleAlert,
  Undo2,
  Waypoints,
  Wrench,
  type LucideIcon,
} from "lucide-react"

/**
 * How loudly an event reads in the activity feed. Routine steps recede so
 * milestones, warnings and failures stand out.
 */
export type EventTone = "routine" | "info" | "success" | "warning" | "danger"

export type EventPresentation = { icon: LucideIcon; tone: EventTone }

const routine = (icon: LucideIcon) => ({ icon, tone: "routine" }) as const
const info = (icon: LucideIcon) => ({ icon, tone: "info" }) as const
const success = (icon: LucideIcon) => ({ icon, tone: "success" }) as const
const warning = (icon: LucideIcon) => ({ icon, tone: "warning" }) as const
const danger = (icon: LucideIcon) => ({ icon, tone: "danger" }) as const

export function presentEvent(event: DomainEvent): EventPresentation {
  switch (event.type) {
    case "engineer.assessed":
      return routine(Bot)
    case "dispatcher.engineer_notice_raised":
      return warning(Radio)
    case "dispatcher.engineer_notice_acknowledged":
      return routine(BadgeCheck)
    case "dispatcher.engineer_notice_resolved":
      return success(CircleCheck)
    case "dispatcher.conflict_investigating":
      return info(ScanEye)
    case "dispatcher.conflict_reported":
      return warning(GitMergeConflict)
    case "dispatcher.conflict_cleared":
      return success(GitMerge)
    case "dispatcher.conflict_investigation_failed":
      return routine(TriangleAlert)
    case "dispatcher.conflict_acknowledged":
      return routine(BadgeCheck)
    case "station.run_failed":
      return warning(TriangleAlert)
    case "line.created":
    case "dispatcher.lines_laid":
      return routine(Waypoints)

    case "train.created":
      return routine(TrainFront)
    case "train.departed":
      return info(TrainTrack)
    case "train.approaching":
      return routine(Locate)
    case "train.arrived":
      return routine(MapPin)
    case "train.held":
      return warning(CirclePause)
    case "train.released":
    case "train.cleared":
      return info(CirclePlay)
    case "train.blocked":
      return danger(OctagonAlert)
    case "train.issue_raised":
      return warning(TriangleAlert)
    case "train.returning":
      return routine(ArrowRightToLine)
    case "train.unloaded":
      return success(PackageCheck)
    case "train.sided":
      return routine(Archive)
    case "train.unload_mode_changed":
      return routine(Info)
    case "train.unload_approved":
      return success(BadgeCheck)

    case "station.signaled":
      return info(Radio)
    case "station.workspace_created":
      return routine(FolderGit2)
    case "station.started":
      return routine(Bot)
    case "station.ready_for_pickup":
      return info(Package)
    case "station.returned":
      return warning(Undo2)
    case "station.blocked":
      return danger(OctagonAlert)
    case "station.reset":
      return routine(RotateCcw)
    case "station.stop_requested":
      return warning(CircleStop)
    case "station.run_retried":
      return warning(RotateCw)
    case "station.cancelled":
      return warning(CircleX)
    case "station.removal_requested":
      return routine(Trash2)
    case "station.removal_refused":
      return warning(Ban)

    case "review.started":
      return info(ScanEye)
    case "car.attached":
      return success(TrainFront)
    case "conflict.detected":
      return danger(GitMergeConflict)
    case "conflict.resolved":
      return success(GitMerge)
    case "hold.placed":
      return warning(CirclePause)
    case "hold.released":
      return routine(CirclePlay)

    case "crossing.created":
      return routine(ArrowLeftRight)
    case "crossing.approaching":
      return routine(Locate)
    case "crossing.started":
      return info(ScanEye)
    case "crossing.blocked":
      return danger(OctagonAlert)
    case "crossing.retried":
      return warning(RotateCw)
    case "crossing.completed":
      return success(TrainFront)

    case "dispatcher.plan_requested":
      return info(Sparkles)
    case "dispatcher.plan_ready":
      return info(ClipboardList)
    case "dispatcher.launch_requested":
      return routine(Rocket)
    case "dispatcher.plan_launched":
      return success(Rocket)
    case "dispatcher.plan_stopped":
    case "dispatcher.plan_cancelled":
      return routine(Info)
    case "dispatcher.plan_failed":
      return danger(OctagonAlert)
    case "dispatcher.baseline_fix_selected":
    case "dispatcher.unload_mode_changed":
      return routine(Info)
    case "dispatcher.user_attention_requested":
    case "dispatcher.junction_attention_requested":
      return danger(Siren)

    case "technician.dispatched":
      return info(Wrench)
    case "technician.started":
    case "technician.candidate_prepared":
      return routine(Wrench)
    case "technician.validated":
      return success(ShieldCheck)
    case "technician.reviewed":
      return info(ScanEye)
    case "technician.approved":
      return success(BadgeCheck)
    case "technician.failed":
    case "technician.integration_failed":
      return danger(OctagonAlert)
    case "technician.integrated":
      return success(GitMerge)
    case "technician.stale":
      return warning(TriangleAlert)

    case "terminus.integration_requested":
      return routine(LogIn)
    case "terminus.clearance_granted":
      return info(CircleCheck)
    case "terminus.integration_started":
      return info(GitMerge)
    case "terminus.candidate_prepared":
      return routine(GitMerge)
    case "terminus.integration_deferred":
      return warning(Hourglass)
    case "terminus.integration_interrupted":
      return warning(TriangleAlert)
    case "terminus.integration_retried":
      return warning(RotateCw)
    case "terminus.integration_failed":
      return danger(OctagonAlert)
    case "terminus.promoted":
      return success(GitCommitVertical)
    case "terminus.integration_completed":
      return success(GitMerge)
    case "terminus.published":
      return success(CloudUpload)

    case "junction.created":
    case "junction.candidate_prepared":
      return routine(Merge)
    case "junction.integration_requested":
      return routine(LogIn)
    case "junction.integration_started":
      return info(Merge)
    case "junction.review_started":
      return info(ScanEye)
    case "junction.integration_reviewed":
      return routine(ScanEye)
    case "junction.input_accepted":
      return success(Merge)
    case "junction.promotion_confirmed":
      return success(GitCommitVertical)
    case "junction.ready":
      return success(CircleCheck)
    case "junction.release_approved":
      return success(BadgeCheck)
    case "junction.released":
      return success(Rocket)
    case "junction.train_unloaded":
      return success(PackageCheck)
    case "junction.retried":
    case "junction.integration_retried":
      return warning(RotateCw)
    case "junction.integration_interrupted":
      return warning(TriangleAlert)
    case "junction.blocked":
    case "junction.integration_failed":
      return danger(OctagonAlert)
    case "junction.abandoned":
      return routine(Archive)
  }
}

/** "Today", "Yesterday", or a short date, for the feed's day dividers. */
export function dayLabel(date: Date, now: Date): string {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
}
