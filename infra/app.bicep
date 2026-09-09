targetScope = 'subscription'

// Per-environment application infrastructure.
// Requires shared.bicep to have been deployed first.

@allowed(['dev', 'prd'])
param env string

param location string = 'westus3'

@description('Static Web Apps is not offered in westus3; westus2 is nearest.')
@allowed(['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'])
param swaLocation string = 'westus2'

param sharedRgName string = 'wus3-shared-rg'
param pgServerName string = 'wus3-lineup-pg'

var appRgName = 'wus3-lineup-${env}-rg'
var swaName = 'lineup-${env}-webapp'
var databaseName = 'lineup-${env}'

// Free tier carries no SLA and cannot hold a custom domain reliably.
var swaSku = env == 'prd' ? 'Standard' : 'Free'

var tags = {
  application: 'lineup'
  environment: env
  managedBy: 'bicep'
}

resource appRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: appRgName
  location: location
  tags: tags
}

module database 'modules/database.bicep' = {
  name: 'database-${env}'
  scope: resourceGroup(sharedRgName)
  params: {
    serverName: pgServerName
    databaseName: databaseName
  }
}

module swa 'modules/swa.bicep' = {
  name: 'swa-${env}'
  scope: appRg
  params: {
    name: swaName
    location: swaLocation
    sku: swaSku
    tags: tags
  }
}

output resourceGroup string = appRgName
output staticWebAppName string = swa.outputs.name
output staticWebAppHost string = swa.outputs.defaultHostname
output databaseName string = database.outputs.databaseName
