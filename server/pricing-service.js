/**
 * Devlups Lab — Multi-Cloud Pricing & Arbitrage Engine
 * Real-time hourly & monthly cost estimation across GCP, AWS, Azure, DigitalOcean
 */

export const PRICING_DATA = {
  gcp: {
    name: 'Google Cloud Platform',
    currency: 'USD',
    rates: {
      'e2-micro':      { hourly: 0.0084, monthly: 6.13,  vcpu: 2, ram: '1 GB',  tier: 'Free Tier Eligible' },
      'e2-small':      { hourly: 0.0168, monthly: 12.26, vcpu: 2, ram: '2 GB',  tier: 'Light Workload' },
      'e2-medium':     { hourly: 0.0336, monthly: 24.53, vcpu: 2, ram: '4 GB',  tier: 'Standard' },
      'e2-standard-2': { hourly: 0.0672, monthly: 49.06, vcpu: 2, ram: '8 GB',  tier: 'High Performance' },
      'e2-standard-4': { hourly: 0.1344, monthly: 98.11, vcpu: 4, ram: '16 GB', tier: 'Compute Intensive' },
    }
  },
  aws: {
    name: 'Amazon Web Services',
    currency: 'USD',
    rates: {
      'e2-micro':      { hourly: 0.0052, monthly: 3.80,  instanceType: 't4g.nano', vcpu: 2, ram: '0.5 GB', tier: 'Free Tier' },
      'e2-small':      { hourly: 0.0104, monthly: 7.59,  instanceType: 't3.micro',  vcpu: 2, ram: '1 GB',   tier: 'Free Tier Eligible' },
      'e2-medium':     { hourly: 0.0208, monthly: 15.18, instanceType: 't3.small',  vcpu: 2, ram: '2 GB',   tier: 'Standard' },
      'e2-standard-2': { hourly: 0.0416, monthly: 30.37, instanceType: 't3.medium', vcpu: 2, ram: '4 GB',   tier: 'General Purpose' },
      'e2-standard-4': { hourly: 0.0832, monthly: 60.74, instanceType: 't3.large',  vcpu: 2, ram: '8 GB',   tier: 'Compute Intensive' },
    }
  },
  azure: {
    name: 'Microsoft Azure',
    currency: 'USD',
    rates: {
      'e2-micro':      { hourly: 0.0075, monthly: 5.48,  instanceType: 'Standard_B1s',  vcpu: 1, ram: '1 GB',  tier: 'Burst Tier' },
      'e2-small':      { hourly: 0.0150, monthly: 10.95, instanceType: 'Standard_B1ms', vcpu: 1, ram: '2 GB',  tier: 'Light Workload' },
      'e2-medium':     { hourly: 0.0300, monthly: 21.90, instanceType: 'Standard_B2s',  vcpu: 2, ram: '4 GB',  tier: 'Standard' },
      'e2-standard-2': { hourly: 0.0600, monthly: 43.80, instanceType: 'Standard_B2ms', vcpu: 2, ram: '8 GB',  tier: 'General Purpose' },
      'e2-standard-4': { hourly: 0.1200, monthly: 87.60, instanceType: 'Standard_B4ms', vcpu: 4, ram: '16 GB', tier: 'Compute Intensive' },
    }
  },
  digitalocean: {
    name: 'DigitalOcean',
    currency: 'USD',
    rates: {
      'e2-micro':      { hourly: 0.0059, monthly: 4.00,  instanceType: 's-1vcpu-1gb', vcpu: 1, ram: '1 GB',  tier: 'Basic Droplet' },
      'e2-small':      { hourly: 0.0089, monthly: 6.00,  instanceType: 's-1vcpu-2gb', vcpu: 1, ram: '2 GB',  tier: 'Basic Droplet' },
      'e2-medium':     { hourly: 0.0178, monthly: 12.00, instanceType: 's-2vcpu-2gb', vcpu: 2, ram: '2 GB',  tier: 'Standard' },
      'e2-standard-2': { hourly: 0.0268, monthly: 18.00, instanceType: 's-2vcpu-4gb', vcpu: 2, ram: '4 GB',  tier: 'Production' },
      'e2-standard-4': { hourly: 0.0536, monthly: 36.00, instanceType: 's-4vcpu-8gb', vcpu: 4, ram: '8 GB',  tier: 'High Performance' },
    }
  }
};

export const pricingService = {
  /**
   * Get pricing comparison across all providers for a specific tier
   */
  getComparison(tier = 'e2-micro') {
    const results = [];

    for (const [providerKey, provider] of Object.entries(PRICING_DATA)) {
      const rate = provider.rates[tier] || provider.rates['e2-micro'];
      results.push({
        provider: providerKey,
        name: provider.name,
        monthly: rate.monthly,
        hourly: rate.hourly,
        vcpu: rate.vcpu,
        ram: rate.ram,
        tierName: rate.tier,
      });
    }

    // Sort ascending by monthly price (cheapest first)
    results.sort((a, b) => a.monthly - b.monthly);

    return {
      tier,
      cheapest: results[0],
      savingsPercentage: Math.round(((results[results.length - 1].monthly - results[0].monthly) / results[results.length - 1].monthly) * 100),
      comparison: results
    };
  },

  /**
   * Determine the cheapest provider from a list of available verified credentials
   */
  selectCheapestProvider(credentials = [], tier = 'e2-micro') {
    if (!credentials || credentials.length === 0) return 'digitalocean';

    let cheapestCred = null;
    let lowestCost = Infinity;

    for (const cred of credentials) {
      const provider = (cred.cloud_provider || 'gcp').toLowerCase();
      const pData = PRICING_DATA[provider] || PRICING_DATA.gcp;
      const rate = pData.rates[tier] || pData.rates['e2-micro'];

      if (rate.monthly < lowestCost) {
        lowestCost = rate.monthly;
        cheapestCred = cred;
      }
    }

    return cheapestCred;
  }
};

