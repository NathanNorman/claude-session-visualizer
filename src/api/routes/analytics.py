"""Analytics routes."""

from fastapi import APIRouter

from ..analytics import get_analytics, get_session_history

router = APIRouter(prefix="/api", tags=["analytics"])


@router.get("/analytics")
def get_analytics_endpoint(period: str = 'week'):
    """Get analytics for the specified period.

    Args:
        period: One of 'day', 'week', 'month', 'year'

    Returns:
        Analytics data with totals, trends, and breakdowns
    """
    return get_analytics(period)


@router.get("/history")
def get_history(page: int = 1, per_page: int = 20, repo: str = None):
    """Get paginated session history.

    Args:
        page: Page number (1-indexed)
        per_page: Sessions per page
        repo: Optional repository filter

    Returns:
        Paginated list of sessions with metadata
    """
    return get_session_history(page, per_page, repo)
