/**
 * Two-step sign-in (text-message codes) in the Lineup Auth tenant.
 *
 * Optional per person (Fady, 10/19): only people who turn it on in Account
 * are asked for a code by text when they sign in. How it works:
 *   - The SMS method is switched on for multifactor sign-in (a paid Entra
 *     add-on, charged per text; Fady approved the cost on 10/19).
 *   - A security group holds the people who turned it on, and a Conditional
 *     Access policy requires multifactor sign-in for that group on the Lineup
 *     web app. Nobody else is affected.
 *   - The API adds and removes people from the group, and can clear a
 *     registered phone so the next sign-in asks for a new number. It uses its
 *     own app registration with only those two permissions; its credentials
 *     go to Key Vault (lineup-<env>-graph-client-id / -graph-client-secret /
 *     -two-step-group-id) and then the Static Web App settings.
 *
 * The tenant policies are changed with a separate "ops" app registration that
 * gets a one-hour secret for this run only, removed again at the end, because
 * the Azure CLI's own sign-in is not allowed to change sign-in policies.
 *
 * Usage: node infra/two-step-setup.cjs <dev|prd> [--dry-run]
 * Requires an az login that is a Global Administrator of the Lineup Auth
 * tenant and can write secrets to the vault. Safe to run again.
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = process.argv[2];
if (!env || !['dev', 'prd'].includes(env)) {
  console.error('usage: node infra/two-step-setup.cjs <dev|prd> [--dry-run]');
  process.exit(1);
}
const DRY = process.argv.includes('--dry-run');

const TENANT = '4412d6d0-0cb9-4270-a8b4-1976b579bafb';
const VAULT = process.env.LINEUP_KEY_VAULT ?? 'wus3-shared-kv';
const SUB = process.env.AZURE_SUBSCRIPTION_ID ?? '5d849fe9-5e3c-4e9a-a77b-c3b05d325519';
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const GROUP_NAME = 'Lineup two-step sign-in';
const OPS_APP_NAME = 'Lineup ops (sign-in policies)';
const API_APP_NAME = 'Lineup API (two-step sign-in)';
const POLICY_NAME = 'Lineup: text-message code for people who turn on two-step sign-in';

const OPS_ROLES = ['Policy.Read.All', 'Policy.ReadWrite.ConditionalAccess', 'Policy.ReadWrite.AuthenticationMethod', 'Application.Read.All'];
const API_ROLES = ['GroupMember.ReadWrite.All', 'UserAuthenticationMethod.ReadWrite.All'];

const sh = (args) =>
  execFileSync('az', args, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function adminToken() {
  return sh(['account', 'get-access-token', '--tenant', TENANT, '--resource', 'https://graph.microsoft.com', '--query', 'accessToken', '-o', 'tsv']);
}

/** Graph call with a bearer token; retries throttling and fresh-object lag. */
async function graph(token, method, path, body, { okStatuses = [], retries = 6 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok || okStatuses.includes(res.status)) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500 || (res.status === 404 && attempt < 3) || (res.status === 400 && /does not exist|not found/i.test(text) && attempt < 3);
    if (retryable && attempt < retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 4000 * (attempt + 1);
      await sleep(wait);
      continue;
    }
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
}

async function ensureApp(token, name, roleNames, graphSp) {
  const found = await graph(token, 'GET', `/applications?$filter=displayName eq '${encodeURIComponent(name)}'&$select=id,appId,displayName,passwordCredentials`);
  let appObj = found.value[0];
  if (!appObj) {
    if (DRY) return { app: null, sp: null };
    const roles = roleNames.map((r) => ({ id: graphSp.appRoles.find((x) => x.value === r).id, type: 'Role' }));
    appObj = await graph(token, 'POST', '/applications', {
      displayName: name,
      signInAudience: 'AzureADMyOrg',
      requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: roles }],
    });
    log(`  created app "${name}" (${appObj.appId})`);
  } else {
    log(`  app "${name}" exists (${appObj.appId})`);
  }
  let sp = (await graph(token, 'GET', `/servicePrincipals?$filter=appId eq '${appObj.appId}'&$select=id,appId`)).value[0];
  if (!sp && !DRY) {
    sp = await graph(token, 'POST', '/servicePrincipals', { appId: appObj.appId });
    log('  created its service principal');
  }
  // Admin consent: grant each application permission to the service principal.
  if (sp) {
    const have = new Set((await graph(token, 'GET', `/servicePrincipals/${sp.id}/appRoleAssignments`)).value.map((a) => a.appRoleId));
    for (const r of roleNames) {
      const roleId = graphSp.appRoles.find((x) => x.value === r).id;
      if (have.has(roleId)) continue;
      if (DRY) {
        log(`  would grant ${r}`);
        continue;
      }
      await graph(token, 'POST', `/servicePrincipals/${sp.id}/appRoleAssignments`, { principalId: sp.id, resourceId: graphSp.id, appRoleId: roleId });
      log(`  granted ${r}`);
    }
  }
  return { app: appObj, sp };
}

async function clientToken(appId, secret) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: appId, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const json = await res.json();
    if (json.access_token) {
      const roles = JSON.parse(Buffer.from(json.access_token.split('.')[1], 'base64url').toString()).roles ?? [];
      return { token: json.access_token, roles };
    }
    // A new secret takes a little while to be accepted.
    await sleep(5000);
  }
  throw new Error(`could not get a token for ${appId}`);
}

function readSecret(name) {
  try {
    return sh(['keyvault', 'secret', 'show', '--vault-name', VAULT, '--name', name, '--query', 'value', '-o', 'tsv', '--only-show-errors']);
  } catch {
    return null;
  }
}

function setSecret(name, value) {
  if (DRY) return log(`  would set ${name}`);
  // Through a short-lived file so the value never appears on a command line.
  const file = path.join(os.tmpdir(), `lineup-${crypto.randomBytes(8).toString('hex')}.txt`);
  fs.writeFileSync(file, value, { mode: 0o600 });
  try {
    sh(['keyvault', 'secret', 'set', '--vault-name', VAULT, '--name', name, '--file', `"${file}"`, '--encoding', 'utf-8', '--only-show-errors', '-o', 'none']);
  } finally {
    fs.rmSync(file, { force: true });
  }
  log(`  stored ${name}`);
}

(async () => {
  log(`Two-step sign-in setup for ${env}${DRY ? ' (dry run)' : ''}`);
  const admin = adminToken();
  const graphSp = (await graph(admin, 'GET', `/servicePrincipals?$filter=appId eq '${GRAPH_APP_ID}'&$select=id,appRoles`)).value[0];
  const webApp = readSecret(`lineup-${env}-oidc-client-id`);
  if (!webApp) throw new Error(`lineup-${env}-oidc-client-id is missing from ${VAULT}`);

  // 1. The group of people who turned it on.
  log('Group');
  let group = (await graph(admin, 'GET', `/groups?$filter=displayName eq '${encodeURIComponent(GROUP_NAME)}'&$select=id,displayName`)).value[0];
  if (!group && !DRY) {
    group = await graph(admin, 'POST', '/groups', {
      displayName: GROUP_NAME,
      description: 'People who turned on two-step sign-in in Lineup. Managed by the Lineup API; a Conditional Access policy asks them for a text-message code.',
      mailEnabled: false,
      mailNickname: 'lineup-two-step',
      securityEnabled: true,
    });
    log(`  created (${group.id})`);
  } else if (group) {
    log(`  exists (${group.id})`);
  }

  // 2. Tenant sign-in policies, through the ops app with a one-hour secret.
  log('Sign-in policies');
  const ops = await ensureApp(admin, OPS_APP_NAME, OPS_ROLES, graphSp);
  if (ops.app && !DRY) {
    const end = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cred = await graph(admin, 'POST', `/applications/${ops.app.id}/addPassword`, {
      passwordCredential: { displayName: `two-step-setup ${new Date().toISOString().slice(0, 16)}`, endDateTime: end },
    });
    try {
      let t = await clientToken(ops.app.appId, cred.secretText);
      // Newly granted permissions can take a minute to show up in the token.
      for (let i = 0; i < 12 && !OPS_ROLES.every((r) => t.roles.includes(r)); i++) {
        await sleep(10000);
        t = await clientToken(ops.app.appId, cred.secretText);
      }
      const missing = OPS_ROLES.filter((r) => !t.roles.includes(r));
      if (missing.length) throw new Error(`ops token is missing ${missing.join(', ')}; run again in a few minutes`);

      // SMS as a second step for everyone (only the policy below asks for it).
      const sms = await graph(t.token, 'GET', '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Sms');
      const allUsers = (sms.includeTargets ?? []).some((x) => x.id === 'all_users');
      if (sms.state !== 'enabled' || !allUsers) {
        await graph(t.token, 'PATCH', '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Sms', {
          '@odata.type': '#microsoft.graph.smsAuthenticationMethodConfiguration',
          state: 'enabled',
          includeTargets: [{ targetType: 'group', id: 'all_users', isUsableForSignIn: false }],
        });
        log('  SMS turned on for multifactor sign-in');
      } else {
        log('  SMS already on');
      }

      // Conditional Access: the group, on the Lineup web app, needs the second step.
      // The tenant came with Security defaults on, which rules out Conditional
      // Access. Its two protections are kept as policies of their own
      // (Microsoft's standard ones): administrators always use a second step,
      // and old sign-in protocols that cannot do one are blocked. All three are
      // created switched off first, then Security defaults is turned off, then
      // they are switched on, so nothing is unprotected for more than moments.
      const ADMIN_ROLES = [
        '62e90394-69f5-4237-9190-012177145e10', // Global Administrator
        '194ae4cb-b126-40b2-bd5b-6091b380977d', // Security Administrator
        'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9', // Conditional Access Administrator
        'e8611ab8-c189-46e8-94e1-60213ab1f814', // Privileged Role Administrator
        '7be44c8a-adaf-4e2a-84d6-ab2649e08a13', // Privileged Authentication Administrator
        'c4e39bd9-1100-46d3-8c65-fb160da0071f', // Authentication Administrator
        '0526716b-113d-4c15-b2c8-68e3c22b9f80', // Authentication Policy Administrator
        'fe930be7-5e62-47db-91af-98c3a49a38b1', // User Administrator
        '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', // Application Administrator
        '158c047a-c907-4556-b7ef-446551a6b5f7', // Cloud Application Administrator
        '729827e3-9c14-49f7-bb1b-9608f156bbb8', // Helpdesk Administrator
        '966707d0-3269-4727-9be2-8c3a10f19b9d', // Password Administrator
        'b0f54661-2d74-4c50-afa3-1ec803f12efe', // Billing Administrator
        '6e591065-9bad-43ed-90f3-e9424366d2f0', // External ID User Flow Administrator
        'be2f45a1-457d-42af-a067-6ec1fa63bc45', // External Identity Provider Administrator
      ];
      const wanted = [
        {
          displayName: POLICY_NAME,
          conditions: {
            users: { includeGroups: [group.id] },
            applications: { includeApplications: [webApp] },
            clientAppTypes: ['all'],
          },
          grantControls: { operator: 'OR', builtInControls: ['mfa'] },
        },
        {
          displayName: 'Lineup Auth: administrators always use a second step',
          conditions: {
            users: { includeRoles: ADMIN_ROLES },
            applications: { includeApplications: ['All'] },
            clientAppTypes: ['all'],
          },
          grantControls: { operator: 'OR', builtInControls: ['mfa'] },
        },
        {
          displayName: 'Lineup Auth: block old sign-in protocols',
          conditions: {
            users: { includeUsers: ['All'] },
            applications: { includeApplications: ['All'] },
            clientAppTypes: ['exchangeActiveSync', 'other'],
          },
          grantControls: { operator: 'OR', builtInControls: ['block'] },
        },
      ];
      const policies = (await graph(t.token, 'GET', `/identity/conditionalAccess/policies?$select=id,displayName,state`)).value;
      const ids = [];
      for (const w of wanted) {
        const existing = policies.find((p) => p.displayName === w.displayName);
        if (existing) {
          await graph(t.token, 'PATCH', `/identity/conditionalAccess/policies/${existing.id}`, { ...w, state: existing.state });
          ids.push(existing.id);
          log(`  policy "${w.displayName}" updated`);
        } else {
          const created = await graph(t.token, 'POST', '/identity/conditionalAccess/policies', { ...w, state: 'disabled' });
          ids.push(created.id);
          log(`  policy "${w.displayName}" created (off for now)`);
        }
      }
      const defaults = await graph(t.token, 'GET', '/policies/identitySecurityDefaultsEnforcementPolicy');
      if (defaults.isEnabled) {
        await graph(t.token, 'PATCH', '/policies/identitySecurityDefaultsEnforcementPolicy', { isEnabled: false });
        log('  Security defaults turned off (replaced by the policies above)');
      }
      for (const id of ids) {
        await graph(t.token, 'PATCH', `/identity/conditionalAccess/policies/${id}`, { state: 'enabled' });
      }
      log('  all three policies switched on');
    } finally {
      await graph(admin, 'POST', `/applications/${ops.app.id}/removePassword`, { keyId: cred.keyId }).catch((e) => log(`  could not remove the one-hour secret: ${e.message}`));
      log('  one-hour ops secret removed');
    }
  }

  // 3. The API's own app: group membership and phone methods only.
  log('API access');
  const api = await ensureApp(admin, API_APP_NAME, API_ROLES, graphSp);
  if (api.app) {
    const idName = `lineup-${env}-graph-client-id`;
    const secretName = `lineup-${env}-graph-client-secret`;
    const groupName = `lineup-${env}-two-step-group-id`;
    if (readSecret(idName) !== api.app.appId) setSecret(idName, api.app.appId);
    if (!readSecret(secretName) && !DRY) {
      const cred = await graph(admin, 'POST', `/applications/${api.app.id}/addPassword`, {
        passwordCredential: { displayName: `lineup-${env}-api`, endDateTime: new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString() },
      });
      setSecret(secretName, cred.secretText);
    }
    if (group && readSecret(groupName) !== group.id) setSecret(groupName, group.id);
  }

  log('Done. Push the settings with: node infra/set-settings.cjs ' + env + '  (keeps PAYWALL_ENABLED from the environment)');
  log(`Subscription for billing: ${SUB}`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
