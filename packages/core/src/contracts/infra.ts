import { describe, expect, test } from 'vitest'
import type { InboundMessage } from '../messages.ts'
import type { ChannelPort, ClockPort, QueuePort, RandomPort, StorePort } from '../ports.ts'

type Make<T> = () => T | Promise<T>

export const channelContract = (
  name: string,
  make: Make<{ channel: ChannelPort; inject(message: InboundMessage): void }>,
) =>
  describe(`ChannelPort contract: ${name}`, () => {
    const message: InboundMessage = {
      id: 'm1',
      channel: 'c1',
      thread: 't1',
      sender: 'u1',
      body: 'hello',
      mentionsAgent: true,
      isDirect: false,
      at: 1,
    }

    test('poll returns injected messages once, in order', async () => {
      const { channel, inject } = await make()
      inject(message)
      inject({ ...message, id: 'm2' })
      expect((await channel.poll()).map((m) => m.id)).toEqual(['m1', 'm2'])
      expect(await channel.poll()).toEqual([])
    })

    test('send resolves', async () => {
      const { channel } = await make()
      await expect(channel.send({ channel: 'c1', thread: 't1', body: 'ack', at: 2 })).resolves.toBeUndefined()
    })
  })

export const queueContract = (name: string, make: Make<QueuePort<string>>) =>
  describe(`QueuePort contract: ${name}`, () => {
    test('dequeues by priority, then insertion order', async () => {
      const queue = await make()
      await queue.enqueue('a')
      await queue.enqueue('b', 5)
      await queue.enqueue('c')
      await queue.enqueue('d', 5)
      expect(await queue.size()).toBe(4)
      const order = [
        await queue.dequeue(),
        await queue.dequeue(),
        await queue.dequeue(),
        await queue.dequeue(),
      ]
      expect(order).toEqual(['b', 'd', 'a', 'c'])
    })

    test('dequeue on empty returns null', async () => {
      const queue = await make()
      expect(await queue.dequeue()).toBeNull()
      expect(await queue.size()).toBe(0)
    })
  })

export const storeContract = (name: string, make: Make<StorePort>) =>
  describe(`StorePort contract: ${name}`, () => {
    test('append keeps insertion order and list filters by field', async () => {
      const store = await make()
      await store.append('usage', { taskId: 't1', n: 1 })
      await store.append('usage', { taskId: 't2', n: 2 })
      await store.append('usage', { taskId: 't1', n: 3 })
      await store.append('other', { taskId: 't1', n: 9 })
      expect((await store.list('usage')).map((r) => r.n)).toEqual([1, 2, 3])
      expect((await store.list('usage', { taskId: 't1' })).map((r) => r.n)).toEqual([1, 3])
      expect(await store.list('usage', { taskId: 't1', n: 3 })).toEqual([{ taskId: 't1', n: 3 }])
    })

    test('put upserts by id and get reads it back', async () => {
      const store = await make()
      expect(await store.get('task', 'a')).toBeNull()
      await store.put('task', 'a', { status: 'received', nested: { k: [1, 'x', null] } })
      await store.put('task', 'a', { status: 'done' })
      await store.put('task', 'b', { status: 'received' })
      expect(await store.get('task', 'a')).toEqual({ status: 'done' })
      expect(await store.list('task')).toHaveLength(2)
    })

    test('filter values cannot break out of the query', async () => {
      const store = await make()
      await store.append('usage', { taskId: 't1' })
      expect(await store.list('usage', { taskId: "' OR '1'='1" })).toEqual([])
      expect(await store.list('usage', { "taskId') OR 1=1 --": 't1' })).toEqual([])
    })
  })

export const clockContract = (
  name: string,
  make: Make<{ clock: ClockPort; settle(pending: Promise<unknown>): Promise<void> }>,
) =>
  describe(`ClockPort contract: ${name}`, () => {
    test('sleep resolves no earlier than the requested time', async () => {
      const { clock, settle } = await make()
      const start = clock.now()
      await settle(clock.sleep(20))
      expect(clock.now()).toBeGreaterThanOrEqual(start + 20)
    })

    test('sleepers wake in time order', async () => {
      const { clock, settle } = await make()
      const woke: string[] = []
      const late = clock.sleep(30).then(() => woke.push('late'))
      const early = clock.sleep(10).then(() => woke.push('early'))
      await settle(Promise.all([late, early]))
      expect(woke).toEqual(['early', 'late'])
    })
  })

export const randomContract = (name: string, make: Make<RandomPort>) =>
  describe(`RandomPort contract: ${name}`, () => {
    test('next stays within [0, 1) and varies', async () => {
      const random = await make()
      const values = Array.from({ length: 200 }, () => random.next())
      expect(values.every((v) => v >= 0 && v < 1)).toBe(true)
      expect(new Set(values).size).toBeGreaterThan(100)
    })
  })
