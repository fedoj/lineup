targetScope = 'subscription'

@description('Deployment environment discriminator.')
@allowed(['dev', 'prd'])
param env string

@description('Azure region for all resources.')
param location string = 'westus3'

@description('Static Web Apps is not offered in westus3; westus2 is the nearest supported region.')
@allowed(['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'])
param swaLocation string = 'westus2'

@description('Administrator login for the shared PostgreSQL server.')
param pgAdminLogin string = 'lineupadmin'

@description('Administrator password for the shared PostgreSQL server.')
@secure()
param pgAdminPassword string

@description('Deploy the shared resource group and PostgreSQL server. Run once.')
param deployShared bool = false

var sharedRgName = 'wus3-shared-rg'
var appRgName = 'wus3-lineup-${env}-rg'
var pgServerName = 'wus3-lineup-pg'
var swaName = 'lineup-${env}-webapp'
var databaseName = 'lineup-${env}'

// SWA Free has no custom-domain SLA; production gets Standard.
var swaSku = env == 'prd' ? 'Standard' : 'Free'

var tags = {
  application: 'lineup'
  environment: env
  managedBy: 'bicep'
}

resource sharedRg 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployShared) {
  name: sharedRgName
  location: location
  tags: {
    application: 'platform'
    environment: 'shared'
    managedBy: 'bicep'
  }
}

resource appRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: appRgName
  location: location
  tags: tags
}

module postgres 'modules/postgres.bicep' = if (deployShared) {
  name: 'pg-${env}'
  scope: resourceGroup(sharedRgName)
  params: {
    serverName: pgServerName
    location: location
    adminLogin: pgAdminLogin
    adminPassword: pgAdminPassword
  }
  dependsOn: [sharedRg]
}

// Databases are created per environment against the shared server.
module database 'modules/database.bicep' = {
  name: 'db-${env}'
  scope: resourceGroup(sharedRgName)
  params: {
    serverName: pgServerName
    databaseName: databaseName
  }
}

module swa 'modules/swa.bicep' = {
  name: 'swa-${env}'
  scope: resourceGroup(appRgName)
  params: {
    name: swaName
    location: swaLocation
    sku: swaSku
    tags: tags
  }
  dependsOn: [appRg]
}

output resourceGroup string = appRgName
output staticWebAppName string = swaName
output staticWebAppHost string = swa.outputs.defaultHostname
output postgresServer string = pgServerName
output databaseName string = databaseName
