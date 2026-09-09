@description('PostgreSQL Flexible Server name.')
param serverName string

param location string = resourceGroup().location

@description('Administrator login.')
param adminLogin string

@secure()
param adminPassword string

@description('Burstable tier is sufficient for early scale and keeps cost low.')
param skuName string = 'Standard_B1ms'

param storageSizeGB int = 32

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: {
    application: 'platform'
    environment: 'shared'
    managedBy: 'bicep'
  }
  sku: {
    name: skuName
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// Static Web Apps managed functions call out from shared Azure IPs, so the
// server must accept Azure services. Tighten to VNet if this ever holds
// anything sensitive.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output serverName string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
