import type { Risk, Stage } from '@crewdesk/core'

export type Route = { stage: Stage; risk?: Risk; model: string }

export const routeModel = (routes: Route[], stage: Stage, risk?: Risk): string => {
  const route =
    routes.find(
      (candidate) => candidate.stage === stage && candidate.risk !== undefined && candidate.risk === risk,
    ) ?? routes.find((candidate) => candidate.stage === stage && candidate.risk === undefined)
  if (!route) throw new Error(`no model route for stage ${stage}`)
  return route.model
}
