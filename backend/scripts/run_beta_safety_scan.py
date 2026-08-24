"""Run the authoritative audit-derived Beta safety scan in the control DB."""

import asyncio

from src.database import AsyncSessionLocal, engine
from src.services.beta_evidence_service import scan_hard_safety


async def main() -> None:
    try:
        async with AsyncSessionLocal() as db:
            result = await scan_hard_safety(db, source="readiness_calibration")
            print(result)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
