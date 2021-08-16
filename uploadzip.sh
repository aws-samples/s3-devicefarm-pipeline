if [[ $# -eq 0 ]] ; then
    echo 'Provide the s3 url as argument:'
    echo ' ./upload.sh <s3_url>'
    exit 0
fi
zip -j app.zip app/*
aws s3 cp app.zip $1
rm app.zip