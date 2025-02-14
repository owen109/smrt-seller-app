#!/bin/bash

# Generate a unique SKU based on current timestamp
TIMESTAMP=$(date +%Y%m%d%H%M%S)
SKU="TEST_${TIMESTAMP}"

# Make the curl request
curl -X POST http://localhost:3456/automation/start \
  -H "Content-Type: application/json" \
  -d '{
    "type": "createListing",
    "params": {
      "asin": "0140268308",
      "sku": "'$SKU'",
      "price": "9.99",
      "condition": "Used - Very Good",
      "conditionNotes": "Item is in very good condition with minimal wear."
    }
  }'

echo "\n\nRequest sent with SKU: $SKU" 
