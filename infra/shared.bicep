targetScope = 'subscription'

// Shared platform infrastructure. Deploy once; every app reuses it.

param location string = 'westus3'
param sharedRgName string = 'wus3-shared-rg'
param pgServerName string = 'wus3-lineup-pg'
param pgAdminLogin string = 'lineupadmin'

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

output sharedResourceGroup string = sharedRg.name
output postgresServer string = postgres.outputs.serverName
output postgresFqdn string = postgres.outputs.fqdn
