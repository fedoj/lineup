/**
 * Microsoft Graph in the Lineup Auth tenant, for two-step sign-in only
 * (infra/two-step-setup.cjs). The API's own app registration may change one
 * group's members and people's registered phone numbers, nothing else.
 */

interface GraphConfig {
  tenant: string;
  clientId: string;
  secret: string;
  groupId: string;
}

export function twoStepConfig(): GraphConfig | null {
  const tenant = process.env.AUTH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  const groupId = process.env.TWO_STEP_GROUP_ID;
  return tenant && clientId && secret && groupId ? { tenant, clientId, secret, groupId } : null;
}

let cached: { token: string; expires: number } | null = null;

async function token(cfg: GraphConfig): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!json.access_token) throw new Error(`graph token: ${json.error_description ?? res.status}`);
  cached = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function graph<T>(cfg: GraphConfig, method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token(cfg)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person's Entra object id: what Static Web Apps gives as the subject. */
export function isObjectId(subject: string): boolean {
  return GUID.test(subject);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Is the person in the group? Lists the members (the group only holds people
 * who turned it on) and retries briefly: right after a change, Graph can
 * answer from a copy that has not caught up yet.
 */
export async function inTwoStepGroup(cfg: GraphConfig, userId: string, expect?: boolean): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    let found = false;
    let path: string | null = `/groups/${cfg.groupId}/members?$select=id&$top=999`;
    let failed = false;
    while (path) {
      const r: { status: number; data: { value: Array<{ id: string }>; '@odata.nextLink'?: string } | null } = await graph(cfg, 'GET', path);
      if (r.status !== 200) {
        failed = true;
        break;
      }
      if (r.data?.value.some((m) => m.id === userId)) found = true;
      const next = r.data?.['@odata.nextLink'];
      path = next ? next.replace('https://graph.microsoft.com/v1.0', '') : null;
    }
    const settled = !failed && (expect === undefined || found === expect);
    if (settled || attempt >= 4) {
      if (failed) throw new Error('group check failed');
      return found;
    }
    await sleep(800 * (attempt + 1));
  }
}

export async function setTwoStep(cfg: GraphConfig, userId: string, on: boolean): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = on
      ? await graph(cfg, 'POST', `/groups/${cfg.groupId}/members/$ref`, {
          '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
        })
      : await graph(cfg, 'DELETE', `/groups/${cfg.groupId}/members/${userId}/$ref`);
    // 204 done; 400 on adding means already a member; 404 on removing means not one.
    if (r.status === 204 || (on && r.status === 400) || (!on && r.status === 404)) return;
    if (attempt >= 3) throw new Error(`could not turn ${on ? 'on' : 'off'}: ${r.status}`);
    await sleep(800 * (attempt + 1));
  }
}

interface PhoneMethod {
  id: string;
  phoneNumber: string;
  phoneType: string;
}

export async function phoneMethods(cfg: GraphConfig, userId: string): Promise<PhoneMethod[]> {
  const r = await graph<{ value: PhoneMethod[] }>(cfg, 'GET', `/users/${userId}/authentication/phoneMethods`);
  return r.status === 200 ? (r.data?.value ?? []) : [];
}

/** Forget the person's phone numbers, so the next sign-in asks for one. */
export async function clearPhones(cfg: GraphConfig, userId: string): Promise<number> {
  const phones = await phoneMethods(cfg, userId);
  for (const p of phones) {
    const r = await graph(cfg, 'DELETE', `/users/${userId}/authentication/phoneMethods/${p.id}`);
    if (r.status !== 204 && r.status !== 404) throw new Error(`could not remove a phone: ${r.status}`);
  }
  return phones.length;
}

/** "+1 555 123 4567" -> "•••• 4567". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}
