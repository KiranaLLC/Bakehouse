/**
 * Checks whether an address is inside the delivery area, using the free
 * OpenStreetMap address lookup (Nominatim) straight from the browser.
 */
import { DELIVERY, DELIVERY_SERVICE } from "./macros.js";
import { findDeliveryZone } from "./delivery-rules.js";

const ORIGIN_CACHE_KEY = "kirana-kitchen-location";

export class AddressNotFoundError extends Error {}

let originCoordinates;

/**
 * address: a free-form string, or { line1, city, postalCode }.
 * Resolves to { distanceMiles, zone } where zone is null if we don't deliver there.
 */
export async function checkDeliveryArea(address) {
  const origin = await getOriginCoordinates();
  const destination = await geocodeAddress(address);
  const distanceMiles = Number(calculateDistanceMiles(origin, destination).toFixed(1));
  return { distanceMiles, zone: findDeliveryZone(distanceMiles) };
}

async function getOriginCoordinates() {
  if (originCoordinates) return originCoordinates;

  try {
    const cached = JSON.parse(localStorage.getItem(ORIGIN_CACHE_KEY));
    if (cached?.address === DELIVERY_SERVICE.originAddress) return (originCoordinates = cached.location);
  } catch {
    // Storage unavailable; look it up instead.
  }

  originCoordinates = await geocodeAddress(DELIVERY_SERVICE.originAddress);

  try {
    localStorage.setItem(ORIGIN_CACHE_KEY, JSON.stringify({ address: DELIVERY_SERVICE.originAddress, location: originCoordinates }));
  } catch {
    // Ignore.
  }

  return originCoordinates;
}

/*
  Structured searches are more accurate, so try
  that first and fall back to a free-form search.
*/
async function geocodeAddress(address) {
  const searches = typeof address === "string"
    ? [{ q: address }]
    : [
      { street: address.line1, city: address.city, state: DELIVERY.state, postalcode: address.postalCode },
      { q: `${address.line1}, ${address.city}, ${DELIVERY.state} ${address.postalCode}` }
    ];

  for (const search of searches) {
    const location = await searchGeocoder(search);
    if (location) return location;
  }

  throw new AddressNotFoundError("We couldn't find that address. Please check the street address and ZIP code.");
}

async function searchGeocoder(search) {
  const searchParams = new URLSearchParams({ ...search, format: "jsonv2", limit: "1", countrycodes: DELIVERY_SERVICE.countryCode, email: DELIVERY_SERVICE.contactEmail });

  let response;
  try {
    response = await fetch(`${DELIVERY_SERVICE.geocoderUrl}?${searchParams}`);
  } catch {
    throw new Error("We couldn't check that address right now. Please check your connection and try again.");
  }
  if (!response.ok) throw new Error("We couldn't check that address right now. Please try again in a moment.");

  const [location] = await response.json();
  const latitude = Number(location?.lat);
  const longitude = Number(location?.lon);
  if (!location || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function calculateDistanceMiles(start, end) {
  const toRadians = degrees => degrees * (Math.PI / 180);
  const latitudeDifference = toRadians(end.latitude - start.latitude);
  const longitudeDifference = toRadians(end.longitude - start.longitude);
  const haversine = Math.sin(latitudeDifference / 2) ** 2 + Math.cos(toRadians(start.latitude)) * Math.cos(toRadians(end.latitude)) * Math.sin(longitudeDifference / 2) ** 2;
  return DELIVERY_SERVICE.earthRadiusMiles * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}
