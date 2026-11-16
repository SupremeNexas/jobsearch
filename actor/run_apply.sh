#!/bin/bash
# Move to the actor directory
cd "$(dirname "$0")"

echo "=========================================================="
echo " Starting Resume Automation System (Applied Dry Run Test) "
echo "=========================================================="

# Run the test application
node src/test_run.js

echo "=========================================================="
echo " Process Finished! Verification screenshots saved at:      "
echo " actor/autofill_result.png                                "
echo "=========================================================="
