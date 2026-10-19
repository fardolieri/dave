import { expect, test, type Friend } from './fixtures';

// Private texts (ADR 0007): a text to one friend in the room, sealed so that only the two of them can read it, and
// relayed by the Room to that friend alone. These pin what each friend sees, and what reaches Carol's browser at all.

/** Opens a friend's profile card from the Online list and starts writing to them privately. */
async function writePrivately(from: Friend, to: string): Promise<void> {
  await from.page.locator('aside.side > ul.plist li', { hasText: to }).locator('button.avatar').click();
  await from.page.locator('.profile').getByRole('button', { name: /Message privately/ }).click();
  await expect(from.page.locator('.private-to')).toContainText(to);
}

/** The private texts in the chat on screen, as `text` with its mark ("🔒 to you", "🔒 to Bob"), sent ones only. */
async function privateLines(f: Friend): Promise<Array<{ text: string; mark: string }>> {
  return f.page.locator('.chat-log .msg-private:not(.msg-pending)').evaluateAll((els) => els.map((e) => ({
    text: (e.querySelector('.msg-text') as HTMLElement | null)?.innerText.trim() ?? '',
    mark: (e.querySelector('.msg-to') as HTMLElement | null)?.innerText.trim() ?? '',
  })));
}

test('a private text reaches only its friend, and an answer goes back the same way', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  await writePrivately(alice, 'Bob');
  await alice.composer.fill('just between us');
  await alice.composer.press('Enter');
  await expect.poll(() => privateLines(bob)).toEqual([{ text: 'just between us', mark: '🔒 to you' }]);
  await expect.poll(() => privateLines(alice)).toEqual([{ text: 'just between us', mark: '🔒 to Bob' }]);

  // Bob answers from the mark on Alice's text.
  await bob.page.locator('.chat-log button.msg-to').click();
  await expect(bob.page.locator('.private-to')).toContainText('Alice');
  await bob.composer.fill('got it');
  await bob.composer.press('Enter');
  await expect.poll(() => privateLines(alice)).toEqual([{ text: 'just between us', mark: '🔒 to Bob' }, { text: 'got it', mark: '🔒 to you' }]);

  // Back to the room: Escape, and the next text is everyone's. A draft written privately goes with it, so the next Enter
  // cannot send it to the room. Carol sees the room's text, and nothing before it.
  await alice.composer.fill('a draft for Bob only');
  await alice.composer.press('Escape');
  await expect(alice.page.locator('.private-to')).toHaveCount(0);
  await expect(alice.composer).toHaveValue('');
  await alice.say('hello everyone');
  await expect.poll(() => carol.chatTexts()).toEqual(['hello everyone']);
  expect(await privateLines(carol)).toEqual([]);
  expect(carol.wire.log.filter((f) => f.dir === 'down' && f.frame.startsWith('{"t":"private"'))).toEqual([]);
  // What the Room relayed holds neither text in the clear.
  for (const f of [...alice.wire.log, ...bob.wire.log]) expect(f.frame).not.toMatch(/between us|got it/);
});

test('a private text kept in the history is still private after a reload', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await writePrivately(alice, 'Bob');
  await alice.composer.fill('still ours');
  await alice.composer.press('Enter');
  await expect.poll(() => privateLines(bob)).toEqual([{ text: 'still ours', mark: '🔒 to you' }]);
  await expect.poll(() => bob.storedTexts()).toEqual(['still ours']);
  await bob.page.reload();
  await bob.connected();
  await expect.poll(() => privateLines(bob)).toEqual([{ text: 'still ours', mark: '🔒 to you' }]);
});

test('a private text written while the server is away survives a reload, and reaches its friend once it is back', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await writePrivately(alice, 'Bob');
  await alice.wire.cut();
  await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
  await alice.composer.fill('kept for you');
  await alice.composer.press('Enter');
  await expect(alice.page.locator('.chat-log .msg-private.msg-pending .msg-text')).toHaveText(['kept for you']);
  await alice.page.reload();
  // Waiting, as written, before the Room is back: sealed only once it lists Bob.
  await expect(alice.page.locator('.chat-log .msg-private.msg-pending .msg-text')).toHaveText(['kept for you']);
  alice.wire.restore();
  await alice.connected();
  await expect.poll(() => privateLines(bob)).toEqual([{ text: 'kept for you', mark: '🔒 to you' }]);
  await expect.poll(() => privateLines(alice)).toEqual([{ text: 'kept for you', mark: '🔒 to Bob' }]);
  await expect(alice.page.locator('.chat-log .msg-pending')).toHaveCount(0);
});
