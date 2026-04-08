import { test, expect } from '@playwright/test'

test('real browser WebRTC connects peer A and peer B across repeated rounds', async ({ page }) => {
  // Two full connect/disconnect rounds can exceed 120s when both directions
  // traverse cross-isolate KV mailbox delivery.
  test.setTimeout(240_000)

  for (let round = 1; round <= 2; round += 1) {
    await page.goto('/')

    const topic = `webrtc-e2e-${Date.now()}-${round}`
    await page.locator('#topic-name').fill(topic)
    await expect(page.locator('.hash-display')).toContainText('SHA-256')

    const peerPanels = page.locator('section.panel')
    await expect(peerPanels).toHaveCount(2)

    const peerA = peerPanels.nth(0)
    const peerB = peerPanels.nth(1)

    await peerA.getByRole('button', { name: 'Connect' }).click()
    await peerB.getByRole('button', { name: 'Connect' }).click()

    const peerALog = peerA.locator('.log')
    const peerBLog = peerB.locator('.log')

    await expect
      .poll(async () => {
        const textA = await peerALog.innerText()
        const textB = await peerBLog.innerText()
        return textA.includes('WebRTC state: connected') && textB.includes('WebRTC state: connected')
      }, {
        timeout: 120_000,
        intervals: [1000, 2000, 3000],
        message: `Expected both peers to reach connected state in round ${round}`,
      })
      .toBe(true)

    await peerA.getByRole('button', { name: 'Disconnect' }).click()
    await peerB.getByRole('button', { name: 'Disconnect' }).click()
  }
})
