targetScope = 'subscription'

// Shared platform infrastructure. Deploy once; every app reuses it.

param location string = 'westus3'
param sharedRgName string = 'wus3-shared-rg'
param pgServerName string = 'wus3-lineup-pg'
param pgAdminLogin string = 'lineupadmin'
param keyVaultName string = 'wus3-shared-kv'
param tenantId string = subscription().tenantId

@description('Object IDs allowed to read and write secrets in the vault.')
param vaultAdminObjectIds array = []

@secure()
param pgAdminPassword string

resource sharedRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: sharedRgName
  location: location
  tags: {
    application: 'platform'
    environment: 'shared'
    managedBy: 'bicep'
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres-server'
  scope: sharedRg
  params: {
    serverName: pgServerName
    location: location
    adminLogin: pgAdminLogin
    adminPassword: pgAdminPassword
  }
}

module vault 'modules/keyvault.bicep' = {
  name: 'key-vault'
  scope: sharedRg
  params: {
    vaultName: keyVaultName
    location: location
    tenantId: tenantId
    adminObjectIds: vaultAdminObjectIds
  }
}

// DNS is hosted at Cloudflare, not Azure. Cloudflare Registrar requires its
// own nameservers on domains registered there, so an Azure DNS zone could
// never be delegated the apex. The SWA records live in the Cloudflare zone as
// grey-cloud (DNS-only) CNAMEs.

output sharedResourceGroup string = sharedRg.name
output postgresServer string = postgres.outputs.serverName
output postgresFqdn string = postgres.outputs.fqdn
output keyVaultName string = vault.outputs.vaultName
output keyVaultUri string = vault.outputs.vaultUri
