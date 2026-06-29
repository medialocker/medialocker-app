# Usage & Billing

Monitor your storage usage and manage your billing plan.

## Usage Dashboard

Navigate to **Usage** to see:

### Storage Gauge
- **Used storage** — Current total size of all objects
- **Allocated storage** — Your plan's capacity
- **Usage percentage** — Visual gauge with color indicators

| Usage Level | Color | Status |
|---|---|---|
| 0–75% | Green | Normal |
| 75–90% | Amber | Approaching limit |
| 90–100% | Red | Near capacity |

### Egress Chart
Shows data transfer out of MediaLocker this month. Includes bandwidth from downloads, API responses, and S3 GET requests.

### Request Count
Total API and S3 requests processed this month.

### Usage History Table
Daily breakdown of storage, egress, and API request counts over time.

## Billing

Navigate to **Billing** to manage your plan.

### Current Plan
Shows your active plan, base storage allocation, and overage rate.

### Adding Capacity
Manually purchase additional storage:

1. Enter the number of GB to add.
2. Click **Add Capacity**.
3. The amount is charged immediately and added to your allocation.

### Auto-Capacity
Automatically add storage when usage passes a threshold:

1. Enable **Auto-Capacity**.
2. Set the **increment** (GB to add each time).
3. Set the **threshold** (percentage at which to trigger).
4. Set the **max spend** (monthly cap on automatic purchases).

Example: With 80% threshold, 100 GB increment, and $500 max spend — when usage hits 80%, 100 GB is automatically added (up to $500/month in auto-purchases).

### Billing History
View past invoices with amounts, status, and download links.

### Stripe Customer Portal
Manage payment methods, view all invoices, and update billing details through the Stripe Customer Portal.

### Downgrade Flow

To downgrade your plan:

1. Click **Request Downgrade**.
2. Review the warning about storage limits.
3. If your usage exceeds the new plan's limit, you must first free up space.
4. Over-limit accounts enter **read-only mode** until usage is below the new limit.

::: warning
Downgrading reduces storage allocation. Ensure your usage is below the target plan's capacity to avoid service interruption.
:::

## Plan Comparison

<!--@include: ../shared/plan-limits.md-->
