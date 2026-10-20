// Platform secret store.
//
// Static Web Apps with a MANAGED functions API cannot resolve
// @Microsoft.KeyVault(...) references and has no managed identity, so this
// vault is not read at runtime by the app. It is the master copy: CI reads
// secrets here at deploy time and writes them into the Static Web App's
// application settings. If the API ever moves to a linked ("bring your own")
// Function App, that app can be given an identity and read this vault directly.
//
// Secrets are named <app>-<environment>-<secret>, e.g. lineup-dev-database-url.

param vaultName string
param location string
param tenantId string

@description('Object IDs that administer the vault (you, and any CI principal).')
param adminObjectIds array = []

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    // RBAC rather than access policies: it is the current model and lets CI
    // be granted a least-privilege reader role without editing the vault.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Deliberately off: a vault that can be purged outright is one bad
    // pipeline run away from an unrecoverable loss of every app secret.
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
  tags: {
    application: 'platform'
    environment: 'shared'
    managedBy: 'bicep'
  }
}

// Key Vault Secrets Officer — read and write secrets, but no control-plane
// rights over the vault itself.
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource adminAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for id in adminObjectIds: {
    name: guid(vault.id, id, secretsOfficerRoleId)
    scope: vault
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        secretsOfficerRoleId
      )
      principalId: id
      principalType: 'User'
    }
  }
]

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output vaultId string = vault.id
