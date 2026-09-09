"""Pull raw features from both cities' ArcGIS services.

Both services reproject server-side via outSR=4326, so there is no pyproj
dependency and no local reprojection step. Both cap page size at 1000 with
geometry regardless of what the service metadata advertises -- always paginate.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

RAW = os.path.join(os.path.dirname(__file__), '..', 'raw')

BERKELEY = 'https://gis.cityofberkeley.info/arcgis/rest/services/Public/Portal_CommSvcs/MapServer'
OAKLAND = ('https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services'
           '/StreetSweeping/FeatureServer/0')


def _get(url, params, tries=4):
    query = urllib.parse.urlencode(params)
    last = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url + '?' + query, timeout=120) as r:
                data = json.load(r)
            if 'error' in data:
                raise RuntimeError(data['error'])
            return data
        except Exception as exc:            # transient server / network trouble
            last = exc
            time.sleep(2 ** attempt)
    raise RuntimeError('%s failed after %d tries: %s' % (url, tries, last))


def paginate(url, fields, geometry=True, page=1000):
    out = []
    offset = 0
    while True:
        data = _get(url + '/query', {
            'where': '1=1',
            'outFields': fields,
            'returnGeometry': 'true' if geometry else 'false',
            'outSR': 4326,
            'orderByFields': 'OBJECTID',
            'resultOffset': offset,
            'resultRecordCount': page,
            'f': 'json',
        })
        feats = data.get('features', [])
        out.extend(feats)
        print('    offset %-6d got %d' % (offset, len(feats)), file=sys.stderr)
        if len(feats) < page:
            return out
        offset += page


def main():
    os.makedirs(RAW, exist_ok=True)
    jobs = [
        ('oakland.json', OAKLAND,
         'OBJECTID,NAME,TYPE,PREFIX,SUFFIX,ROUTE,DAY_ODD,TIME_ODD,DAY_EVEN,TIME_EVEN,'
         'SIDEOFSTREET,DOUBLECK,MAPNO,NOTES,ONE_WAY,FT_DIR,TF_DIR,'
         'L_F_ADD,L_T_ADD,R_F_ADD,R_T_ADD,POSTAL_L,POSTAL_R'),
        ('berkeley_l6.json', BERKELEY + '/6',
         'OBJECTID,STR_NAM,STR_TYP,mech_sweep,Route,Opt_In_Stage,PARKING,LANES,'
         'F_ADDR,T_ADDR,F_ADDL,T_ADDL'),
        ('berkeley_l7.json', BERKELEY + '/7', 'Route,SUM_length,LengthM,No_of_Maps'),
    ]
    for name, url, fields in jobs:
        print('  fetching %s' % name, file=sys.stderr)
        feats = paginate(url, fields)
        with open(os.path.join(RAW, name), 'w') as fh:
            json.dump(feats, fh)
        print('  %s: %d features' % (name, len(feats)), file=sys.stderr)


if __name__ == '__main__':
    main()
