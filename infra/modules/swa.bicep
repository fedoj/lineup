@description('Static Web App name.')
param name string

@description('SWA is only available in a subset of regions; westus2 serves westus3 traffic.')
param location string = 'westus2'

@allowed(['Free', 'Standard'])
param sku string = 'Free'

param tags object = {}

resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    // Deployment is driven by GitHub Actions we author ourselves, so the
    // portal must not generate a competing workflow.
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
    enterpriseGradeCdnStatus: 'Disabled'
  }
}

output id string = swa.id
output name string = swa.name
output defaultHostname string = swa.properties.defaultHostname
