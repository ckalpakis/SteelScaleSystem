export const VOICE_AI_SCORING_VERSION = 'voice-ai-v1';

export const VOICE_AI_WEIGHTS = {
  reviews: [
    { minimum: 150, points: 20 },
    { minimum: 75, points: 15 },
    { minimum: 30, points: 10 },
    { minimum: 10, points: 5 },
    { minimum: 0, points: 0 },
  ],
  rating: [
    { minimum: 4.5, points: 5 },
    { minimum: 4, points: 3 },
  ],
  highPriorityNiche: 15,
  advertises24Hours: 15,
  advertisesEmergency: 15,
  advertisesSameDay: 5,
  noChatbot: 10,
  noOnlineBooking: 10,
  reachableWebsite: 5,
  googleVerified: 3,
  highActivity: {
    minimumReviews: 100,
    minimumPhotos: 50,
    points: 2,
  },
  weakBusiness: {
    maximumReviews: 4,
    maximumPhotos: 2,
    points: -5,
  },
  enterpriseOrFranchise: -10,
} as const;

export const HIGH_VALUE_VOICE_AI_NICHES: Readonly<Record<string, readonly string[]>> = {
  water_restoration: ['water restoration', 'water damage restoration'],
  fire_restoration: ['fire restoration', 'fire damage restoration'],
  mold_remediation: ['mold remediation', 'mould remediation'],
  septic: ['septic', 'septic service'],
  garage_door: ['garage door', 'garage door service'],
  tree_service: ['tree service', 'tree removal', 'arborist'],
  pest_control: ['pest control', 'exterminator'],
  towing: ['towing', 'tow truck'],
  hvac: ['hvac', 'heating and cooling', 'air conditioning contractor'],
  plumbing: ['plumbing', 'plumber'],
  electrician: ['electrician', 'electrical contractor'],
  foundation_repair: ['foundation repair'],
  waterproofing: ['waterproofing'],
  auto_glass: ['auto glass', 'windshield repair'],
  dentist: ['dentist', 'dental clinic'],
  med_spa: ['med spa', 'medical spa'],
  veterinarian: ['veterinarian', 'veterinary clinic', 'animal hospital'],
  property_management: ['property management', 'property manager'],
};

export const ENTERPRISE_OR_FRANCHISE_SIGNALS = ['is_national_franchise', 'is_enterprise'] as const;

export const ENTERPRISE_NAME_MARKERS = [
  ' roto rooter ',
  ' servpro ',
  ' terminix ',
  ' orkin ',
  ' mr rooter ',
  ' one hour heating ',
] as const;
