/**
 * Cloudflare Email Worker: email to support@mahoul.io -> Lineup support queue.
 *
 * Cloudflare Email Routing hands every message sent to support@mahoul.io to
 * this Worker, which posts it to the Lineup API. The API opens a ticket (or
 * adds the email to the ticket its subject tags, like "[#7de1c4b6]"), sends an
 * acknowledgement from noreply@mahoul.io, and emails support's replies back.
 *
 * No npm packages or build step: paste this file into the Worker editor in the
 * Cloudflare dashboard. Variables (Settings > Variables and Secrets):
 *   LINEUP_INBOUND_URL     https://lineup-dev.mahoul.io/api/support/inbound
 *                          (https://lineup.mahoul.io/... once production has it)
 *   LINEUP_INBOUND_SECRET  secret; the value of Key Vault secret
 *                          lineup-<env>-support-inbound-secret
 *   FORWARD_TO             optional; also forward every message to this verified
 *                          address (for example a personal inbox), as a backup
 */

const MAX_RAW_BYTES = 2 * 1024 * 1024;

export default {
  async email(message, env, ctx) {
    const subject = message.headers.get('subject') ?? '';
    let payload;
    if (message.rawSize > MAX_RAW_BYTES) {
      // Too big to pass on (attachments): the ticket says so and asks again.
      payload = { from: message.from, subject, tooLarge: true };
    } else {
      const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
      let binary = '';
      for (let i = 0; i < raw.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, raw.subarray(i, i + 0x8000));
      }
      payload = { from: message.from, subject, raw: btoa(binary) };
    }

    const res = await fetch(env.LINEUP_INBOUND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lineup-inbound-secret': env.LINEUP_INBOUND_SECRET },
      body: JSON.stringify(payload),
    });

    if (env.FORWARD_TO) ctx.waitUntil(message.forward(env.FORWARD_TO).catch(() => undefined));

    // Too many emails from one sender in an hour: bounce with a reason.
    if (res.status === 429) message.setReject('Too many messages to Lineup support from this address. Please try again later.');
    // Any other failure: throw, so Cloudflare reports the delivery as failed.
    else if (!res.ok) throw new Error(`Lineup inbound ${res.status}`);
  },
};
