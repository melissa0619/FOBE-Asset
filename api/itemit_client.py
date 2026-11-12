"""Rate-conscious client for the read-only itemit inventory APIs."""

from __future__ import annotations

import email.utils
import logging
import os
import random
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests
from dotenv import load_dotenv


load_dotenv()
LOGGER = logging.getLogger(__name__)


@dataclass
class _CachedResponse:
    value: Any
    expires_at: float


class ItemitRequestManager:
    """Centralize GET caching, pacing, coalescing, and safe retries."""

    def __init__(self, session, requests_per_minute=70, max_retries=3,
                 clock=time.monotonic, sleep=time.sleep, jitter=random.uniform):
        if not 1 <= requests_per_minute <= 100:
            raise ValueError("requests_per_minute must be between 1 and 100")
        self.session, self.max_retries = session, max_retries
        self._interval = 60 / requests_per_minute
        self._clock, self._sleep, self._jitter = clock, sleep, jitter
        self._lock, self._next_request_at = threading.Lock(), 0.0
        self._cache: dict[tuple, _CachedResponse] = {}
        self._in_flight: dict[tuple, threading.Event] = {}
        self._metrics = {"outgoing_requests": 0, "cache_hits": 0, "cache_misses": 0,
                         "coalesced_requests": 0, "rate_limit_responses": 0,
                         "retry_attempts": 0, "failures": 0}

    @staticmethod
    def _key(path, params):
        return path, tuple(sorted((params or {}).items()))

    def metrics(self):
        """Return counters for real upstream requests without sensitive data."""
        with self._lock:
            return dict(self._metrics)

    def clear_cache(self):
        with self._lock:
            self._cache.clear()

    def _reserve_request_slot(self):
        with self._lock:
            now = self._clock()
            scheduled = max(now, self._next_request_at)
            self._next_request_at = scheduled + self._interval
        if scheduled > now:
            self._sleep(scheduled - now)

    def _defer_until(self, delay):
        with self._lock:
            self._next_request_at = max(self._next_request_at, self._clock() + delay)

    def _retry_delay(self, response, attempt):
        retry_after = response.headers.get("Retry-After") if response.headers else None
        if retry_after:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                try:
                    target = email.utils.parsedate_to_datetime(retry_after)
                    if target.tzinfo is None:
                        target = target.replace(tzinfo=timezone.utc)
                    return max(0.0, (target - datetime.now(timezone.utc)).total_seconds())
                except (TypeError, ValueError, IndexError):
                    pass
        return min(30.0, 2 ** attempt) + self._jitter(0, 0.5)

    def get_json(self, path, *, params=None, cache_ttl=0, force_refresh=False):
        """Get JSON once per cache key, retrying only transient read failures."""
        key, owner, waited = self._key(path, params), False, False
        while not owner:
            with self._lock:
                cached = self._cache.get(key)
                if (not force_refresh or waited) and cached and cached.expires_at > self._clock():
                    self._metrics["cache_hits"] += 1
                    return cached.value
                event = self._in_flight.get(key)
                if event is None:
                    self._in_flight[key] = threading.Event()
                    self._metrics["cache_misses"] += 1
                    owner = True
                else:
                    self._metrics["coalesced_requests"] += 1
            if not owner:
                event.wait()
                waited = True
        try:
            for attempt in range(self.max_retries + 1):
                self._reserve_request_slot()
                with self._lock:
                    self._metrics["outgoing_requests"] += 1
                response = self.session.get(path, params=params, timeout=30)
                if response.status_code != 429:
                    response.raise_for_status()
                    result = response.json()
                    if cache_ttl > 0:
                        with self._lock:
                            self._cache[key] = _CachedResponse(result, self._clock() + cache_ttl)
                    return result
                with self._lock:
                    self._metrics["rate_limit_responses"] += 1
                if attempt >= self.max_retries:
                    response.raise_for_status()
                delay = self._retry_delay(response, attempt)
                self._defer_until(delay)
                with self._lock:
                    self._metrics["retry_attempts"] += 1
                LOGGER.warning("itemit rate limited GET %s; retrying after %.1fs", path, delay)
                self._sleep(delay)
        except Exception:
            with self._lock:
                self._metrics["failures"] += 1
            raise
        finally:
            with self._lock:
                self._in_flight.pop(key).set()


class ItemitClient:
    """Authenticate with itemit and retrieve workspace inventory safely."""

    def __init__(self):
        self.base_url = os.getenv("ITEMIT_BASE_URL", "https://api.itemit.com/v1").rstrip("/")
        credentials = {"X-API-KEY": os.getenv("ITEMIT_API_KEY"), "X-USER-ID": os.getenv("ITEMIT_USER_ID"),
                       "X-USER-TOKEN": os.getenv("ITEMIT_USER_TOKEN"), "X-WORKSPACE-ID": os.getenv("ITEMIT_WORKSPACE_ID")}
        missing = [key for key, value in credentials.items() if not value]
        if missing:
            raise ValueError(f"Missing itemit credentials: {', '.join(missing)}")
        self.session = requests.Session()
        self.session.headers.update({**credentials, "Accept": "application/json"})
        self.request_manager = ItemitRequestManager(self.session, requests_per_minute=int(os.getenv("ITEMIT_REQUESTS_PER_MINUTE", "70")))
        self.item_cache_ttl = int(os.getenv("ITEMIT_ITEM_CACHE_TTL_SECONDS", "1800"))
        self.collection_cache_ttl = int(os.getenv("ITEMIT_COLLECTION_CACHE_TTL_SECONDS", "1800"))
        self.location_cache_ttl = int(os.getenv("ITEMIT_LOCATION_CACHE_TTL_SECONDS", "3600"))

    def request_metrics(self):
        return self.request_manager.metrics()

    def _get(self, endpoint, *, params=None, cache_ttl=0, force_refresh=False):
        return self.request_manager.get_json(f"{self.base_url}/{endpoint.lstrip('/')}", params=params,
                                             cache_ttl=cache_ttl, force_refresh=force_refresh)

    def get_items(self, skip=0, limit=100, force_refresh=False):
        return self._get("items", params={"skip": skip, "limit": limit}, cache_ttl=self.item_cache_ttl, force_refresh=force_refresh)

    def get_item(self, item_id, force_refresh=False):
        return self._get(f"items/{item_id}", cache_ttl=self.item_cache_ttl, force_refresh=force_refresh)

    @staticmethod
    def _membership_state(item):
        nested = item.get("collections") if isinstance(item, dict) else None
        if not isinstance(nested, dict):
            return "UNKNOWN", []
        total, rows = nested.get("total"), nested.get("results")
        if not isinstance(total, int) or total < 0 or not isinstance(rows, list):
            return "INCOMPLETE", []
        ids = [row.get("id") for row in rows if isinstance(row, dict) and row.get("id")]
        if len(ids) != len(rows) or len(ids) != len(set(ids)) or total != len(ids):
            return "INCOMPLETE", ids
        return ("EMPTY" if total == 0 else "COMPLETE"), ids

    def resolve_item_collection_memberships(self, items):
        """Do not make 320 detail requests when the endpoint omits memberships."""
        resolved, detail_memberships_available = [], None
        unsupported = "Item detail response has no explicit Collection data; remaining detail lookups skipped"
        for item in items:
            item_id = item.get("id") if isinstance(item, dict) else None
            if not item_id:
                raise RuntimeError("Item response has incomplete Collection data and no item UUID")
            state, membership_ids = self._membership_state(item)
            source, detail, detail_error = "ITEM_PAGE", None, None
            if state in {"UNKNOWN", "INCOMPLETE"} and detail_memberships_available is not False:
                try:
                    detail = self.get_item(item_id)
                    detail_state, detail_ids = self._membership_state(detail)
                    detail_memberships_available = detail_state in {"COMPLETE", "EMPTY"}
                    if detail_state in {"COMPLETE", "EMPTY"}:
                        state, membership_ids, source = detail_state, detail_ids, "ITEM_DETAIL"
                    elif state == "UNKNOWN" and detail_state == "INCOMPLETE":
                        state, membership_ids, source = "INCOMPLETE", detail_ids, "ITEM_DETAIL"
                    else:
                        detail_error = unsupported
                except Exception as error:  # Enrichment must never block inventory sync.
                    detail_memberships_available = False
                    state, membership_ids, detail_error = "UNKNOWN", [], str(error)
            elif state in {"UNKNOWN", "INCOMPLETE"}:
                detail_error = unsupported
            resolved.append({"item_id": item_id, "status": state, "memberships": membership_ids,
                             "source": source, "raw_item": item, "raw_detail": detail, "detail_error": detail_error})
        return resolved

    def resolve_collection_profile_memberships(self, items, collections, profiles):
        """Resolve item memberships from complete collection-profile responses.

        itemit currently exposes Collection membership on ``collection-profiles``
        rather than on its item or collection list responses.  This method is
        A complete profile snapshot can reconcile additions and removals. When
        itemit truncates one or more nested member lists, the returned members
        are still real memberships, but absence is not meaningful. Those rows
        are therefore marked PARTIAL so the synchronizer may add observed links
        without deleting any existing relationship.
        """
        item_ids = set()
        for item in items:
            item_id = item.get("id") if isinstance(item, dict) else None
            if not item_id:
                raise RuntimeError("Item response has no item UUID")
            item_ids.add(item_id)

        collection_ids = set()
        for collection in collections:
            collection_id = collection.get("id") if isinstance(collection, dict) else None
            if not collection_id:
                raise RuntimeError("Collection response has no Collection UUID")
            collection_ids.add(collection_id)

        profiles_by_id = {}
        problems, incomplete_profiles = [], []
        for profile in profiles:
            profile_id = profile.get("id") if isinstance(profile, dict) else None
            if not profile_id or profile_id in profiles_by_id:
                problems.append("missing or duplicate Collection profile UUID")
                continue
            profiles_by_id[profile_id] = profile
            state, member_ids = self._membership_state({"collections": profile.get("items")})
            if state == "INCOMPLETE":
                incomplete_profiles.append(profile_id)
            elif state == "UNKNOWN":
                problems.append(f"missing members for Collection profile {profile_id}")
                continue
            unknown_members = set(member_ids) - item_ids
            if unknown_members:
                problems.append(f"unknown item UUID in Collection profile {profile_id}")

        missing_profiles = collection_ids - set(profiles_by_id)
        unexpected_profiles = set(profiles_by_id) - collection_ids
        if missing_profiles:
            problems.append("missing Collection profiles")
        if unexpected_profiles:
            problems.append("Collection profiles not returned by the Collections endpoint")

        if problems:
            message = "; ".join(sorted(set(problems)))
            return [{"item_id": item_id, "status": "UNKNOWN", "memberships": [],
                     "source": "COLLECTION_PROFILE", "detail_error": message}
                    for item_id in sorted(item_ids)]

        memberships = {item_id: set() for item_id in item_ids}
        for collection_id, profile in profiles_by_id.items():
            _, member_ids = self._membership_state({"collections": profile.get("items")})
            for item_id in member_ids:
                memberships[item_id].add(collection_id)

        if incomplete_profiles:
            detail_error = (
                f"{len(incomplete_profiles)} Collection profile(s) returned truncated member lists; "
                "only observed memberships can be added"
            )
            return [{"item_id": item_id,
                     "status": "PARTIAL" if memberships[item_id] else "UNKNOWN",
                     "memberships": sorted(memberships[item_id]),
                     "source": "COLLECTION_PROFILE", "detail_error": detail_error}
                    for item_id in sorted(item_ids)]

        return [{"item_id": item_id,
                 "status": "COMPLETE" if memberships[item_id] else "EMPTY",
                 "memberships": sorted(memberships[item_id]),
                 "source": "COLLECTION_PROFILE"}
                for item_id in sorted(item_ids)]

    def get_all_items(self, force_refresh=False):
        return self._paginate(
            lambda skip, limit: self.get_items(skip=skip, limit=limit, force_refresh=force_refresh),
            "items",
        )

    def get_all_collections(self, force_refresh=False):
        return self._get_all("collections", "collections", self.collection_cache_ttl, force_refresh)

    def get_all_collection_profiles(self, force_refresh=False):
        return self._get_all("collection-profiles", "collection profiles",
                             self.collection_cache_ttl, force_refresh)

    def get_all_pages(self, endpoint, limit=100, force_refresh=False):
        return self._get_all(endpoint, endpoint, self.location_cache_ttl, force_refresh, limit)

    def _get_all(self, endpoint, label, cache_ttl, force_refresh, limit=100):
        return self._paginate(
            lambda skip, page_limit: self._get(
                endpoint, params={"skip": skip, "limit": page_limit},
                cache_ttl=cache_ttl, force_refresh=force_refresh,
            ),
            label, limit,
        )

    @staticmethod
    def _paginate(fetch_page, label, limit=100):
        records, skip = [], 0
        while True:
            data = fetch_page(skip, limit)
            page, total = data.get("results"), data.get("total")
            if not isinstance(page, list):
                raise ValueError(f"Invalid response from {label}")
            if not page:
                if total is not None and len(records) < total:
                    raise RuntimeError(f"Pagination stopped before all {label} were fetched")
                break
            records.extend(page)
            print(f"Fetched {len(records)} of {total} {label}")
            if total is not None and len(records) >= total:
                if len(records) != total:
                    raise RuntimeError(f"Pagination exceeded the reported {label} total")
                break
            skip += len(page)
            if len(page) < limit:
                break
        return records

    def get_all_locations(self, force_refresh=False):
        return self.get_all_pages("locations", force_refresh=force_refresh)

    def get_all_location_usage(self, force_refresh=False):
        return self.get_all_pages("items/usage/locations", force_refresh=force_refresh)
