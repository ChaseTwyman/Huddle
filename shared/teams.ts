import type { TeamInfo } from './types';

// Abbreviations, cities, names and colors only. No logos.
export const TEAMS: Record<string, TeamInfo> = {
  ARI: { abbr: 'ARI', city: 'Arizona', name: 'Cardinals', primary: '#97233F', secondary: '#FFB612' },
  ATL: { abbr: 'ATL', city: 'Atlanta', name: 'Falcons', primary: '#A71930', secondary: '#000000' },
  BAL: { abbr: 'BAL', city: 'Baltimore', name: 'Ravens', primary: '#241773', secondary: '#9E7C0C' },
  BUF: { abbr: 'BUF', city: 'Buffalo', name: 'Bills', primary: '#00338D', secondary: '#C60C30' },
  CAR: { abbr: 'CAR', city: 'Carolina', name: 'Panthers', primary: '#0085CA', secondary: '#101820' },
  CHI: { abbr: 'CHI', city: 'Chicago', name: 'Bears', primary: '#0B162A', secondary: '#C83803' },
  CIN: { abbr: 'CIN', city: 'Cincinnati', name: 'Bengals', primary: '#FB4F14', secondary: '#000000' },
  CLE: { abbr: 'CLE', city: 'Cleveland', name: 'Browns', primary: '#311D00', secondary: '#FF3C00' },
  DAL: { abbr: 'DAL', city: 'Dallas', name: 'Cowboys', primary: '#003594', secondary: '#869397' },
  DEN: { abbr: 'DEN', city: 'Denver', name: 'Broncos', primary: '#FB4F14', secondary: '#002244' },
  DET: { abbr: 'DET', city: 'Detroit', name: 'Lions', primary: '#0076B6', secondary: '#B0B7BC' },
  GB: { abbr: 'GB', city: 'Green Bay', name: 'Packers', primary: '#203731', secondary: '#FFB612' },
  HOU: { abbr: 'HOU', city: 'Houston', name: 'Texans', primary: '#03202F', secondary: '#A71930' },
  IND: { abbr: 'IND', city: 'Indianapolis', name: 'Colts', primary: '#002C5F', secondary: '#A2AAAD' },
  JAX: { abbr: 'JAX', city: 'Jacksonville', name: 'Jaguars', primary: '#006778', secondary: '#D7A22A' },
  KC: { abbr: 'KC', city: 'Kansas City', name: 'Chiefs', primary: '#E31837', secondary: '#FFB81C' },
  LA: { abbr: 'LA', city: 'Los Angeles', name: 'Rams', primary: '#003594', secondary: '#FFA300' },
  LAC: { abbr: 'LAC', city: 'Los Angeles', name: 'Chargers', primary: '#0080C6', secondary: '#FFC20E' },
  LV: { abbr: 'LV', city: 'Las Vegas', name: 'Raiders', primary: '#000000', secondary: '#A5ACAF' },
  MIA: { abbr: 'MIA', city: 'Miami', name: 'Dolphins', primary: '#008E97', secondary: '#FC4C02' },
  MIN: { abbr: 'MIN', city: 'Minnesota', name: 'Vikings', primary: '#4F2683', secondary: '#FFC62F' },
  NE: { abbr: 'NE', city: 'New England', name: 'Patriots', primary: '#002244', secondary: '#C60C30' },
  NO: { abbr: 'NO', city: 'New Orleans', name: 'Saints', primary: '#D3BC8D', secondary: '#101820' },
  NYG: { abbr: 'NYG', city: 'New York', name: 'Giants', primary: '#0B2265', secondary: '#A71930' },
  NYJ: { abbr: 'NYJ', city: 'New York', name: 'Jets', primary: '#125740', secondary: '#FFFFFF' },
  PHI: { abbr: 'PHI', city: 'Philadelphia', name: 'Eagles', primary: '#004C54', secondary: '#A5ACAF' },
  PIT: { abbr: 'PIT', city: 'Pittsburgh', name: 'Steelers', primary: '#FFB612', secondary: '#101820' },
  SEA: { abbr: 'SEA', city: 'Seattle', name: 'Seahawks', primary: '#002244', secondary: '#69BE28' },
  SF: { abbr: 'SF', city: 'San Francisco', name: '49ers', primary: '#AA0000', secondary: '#B3995D' },
  TB: { abbr: 'TB', city: 'Tampa Bay', name: 'Buccaneers', primary: '#D50A0A', secondary: '#34302B' },
  TEN: { abbr: 'TEN', city: 'Tennessee', name: 'Titans', primary: '#0C2340', secondary: '#4B92DB' },
  WAS: { abbr: 'WAS', city: 'Washington', name: 'Commanders', primary: '#5A1414', secondary: '#FFB612' },
};

export function team(abbr: string | null | undefined): TeamInfo {
  if (abbr && TEAMS[abbr]) return TEAMS[abbr];
  return { abbr: abbr ?? '?', city: abbr ?? 'Unknown', name: abbr ?? 'Unknown', primary: '#555555', secondary: '#999999' };
}
