# Fictional ERP Spare-Parts Dataset

This small database exists only for automated tests and engineering demonstrations.

## Data policy

- Every person, company, phone number, email address, order, and credential is fictional.
- The CSVs were normalized from a Gemini-generated dataset originally placed under ignored `data/erp_spareparts_db`; its ZIP backup remains local and ignored.
- `ACME-SHIPPING` uses the established exercise address `10 Test Road` so existing fixtures such as `fixtures/01-clean` remain compatible.
- Loading this dataset adds no runtime dependency, vector database, model provider, or agent.

## Files

- `items.csv`: item catalog, base price, and stock-item flag.
- `inventory_bins.csv`: per-warehouse inventory quantities.
- `customers.csv`: customer master data.
- `addresses.csv`: customer shipping-address records.
- `suppliers.csv`: supplier master data.
- `purchase_order_lines.csv`: inbound purchasing history.
- `sales_order_lines.csv`: outbound sales history.
- `validation-report.json`: source-generation validation summary retained as provenance, not runtime evidence.

## Relationships

- `items.csv(Item_Code)` <- `inventory_bins.csv(Item_Code)`, `purchase_order_lines.csv(Item_Code)`, `sales_order_lines.csv(Item_Code)`
- `customers.csv(Customer_ID)` <- `addresses.csv(Customer_ID)`, `sales_order_lines.csv(Customer_ID)`
- `addresses.csv(Address_ID)` <- `sales_order_lines.csv(Shipping_Address_ID)`
- `suppliers.csv(Supplier_ID)` <- `purchase_order_lines.csv(Supplier_ID)`

## Intended test cases

- **Out of stock:** `FILTER-A20` has zero actual quantity.
- **Low stock:** items such as `THERM-B1`, `THERM-P1`, and `AMBIG-12V` are below their minimum stock levels.
- **Ambiguous model:** both `FILTER-A10` and `FILTER-A20` exist, as do `AMBIG-12V` and `AMBIG-24V`. A request for only “Filter” must remain unresolved.
- **Non-stock item:** `NON-STOCK-01` (`Is_Stock_Item=0`) exercises the read-only inventory boundary.
- **Multi-line orders:** purchasing and sales histories contain multiple rows sharing one order number.
- **Duplicate customer PO:** a Draft order for customer `ACME` supports duplicate-identity checks.
- **Location versus shipping address:** customer territory and approved ERP shipping address are stored separately. NLP output must not promote a company location into an authorized delivery address.
- **Unknown product:** neither `X-200` nor `THERM-X200` exists. No catalog match means only “unresolved in this catalog,” not “the business can never supply it.”
