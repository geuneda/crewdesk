#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { deploy, evaluate, init, type Outcome, sim, upgrade } from './commands.ts'
import { record } from './record.ts'

const usage = [
  'crewdesk init <dir> --org <name> [--base <dir>]',
  'crewdesk deploy <dir> [--base <dir>]',
  'crewdesk upgrade <dir> [--base <dir>]',
  'crewdesk eval [--base <dir>] [--cache <file>]',
  'crewdesk sim [--out <dir>] [--days <n>] [--seed <n>] [--base <dir>] [--overlays <dir>] [--recordings <file>]',
  'crewdesk record [--out <dir>] [--runs <n>] [--model <small|medium|large>] --confirm-cost',
]

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))

const whole = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive whole number`)
  return parsed
}

const run = async (): Promise<Outcome> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      org: { type: 'string' },
      base: { type: 'string', default: repo('distro/base') },
      overlays: { type: 'string', default: repo('distro/overlays') },
      out: { type: 'string', default: 'reports' },
      days: { type: 'string', default: '30' },
      seed: { type: 'string', default: '1' },
      cache: { type: 'string' },
      recordings: { type: 'string' },
      runs: { type: 'string', default: '3' },
      model: { type: 'string', default: 'medium' },
      'confirm-cost': { type: 'boolean', default: false },
    },
  })
  const [command, dir] = positionals
  const { base } = values
  if (command === 'init' && dir && values.org) return init({ dir, org: values.org, base })
  if (command === 'deploy' && dir) return deploy({ dir, base })
  if (command === 'upgrade' && dir) return upgrade({ dir, base })
  if (command === 'eval') return evaluate({ base, ...(values.cache ? { cache: values.cache } : {}) })
  if (command === 'sim') {
    return sim({
      base,
      overlays: values.overlays,
      out: values.out,
      days: whole(values.days, 'days'),
      seed: whole(values.seed, 'seed'),
      ...(values.recordings ? { recordings: values.recordings } : {}),
    })
  }
  if (command === 'record') {
    return record({
      base,
      out: values.out,
      runs: whole(values.runs, 'runs'),
      model: values.model,
      confirmCost: values['confirm-cost'],
    })
  }
  return { code: 2, lines: ['usage:', ...usage.map((line) => `  ${line}`)] }
}

const outcome = await run().catch(
  (error: unknown): Outcome => ({
    code: 1,
    lines: [error instanceof Error ? error.message : String(error)],
  }),
)
console.log(outcome.lines.join('\n'))
process.exitCode = outcome.code
