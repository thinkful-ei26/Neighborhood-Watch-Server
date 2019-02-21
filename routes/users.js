'use strict';

const express = require('express');
const passport = require('passport');
const cloudinary = require('cloudinary');
const formData = require('express-form-data');
const {isEmpty} = require ('../helper-functions');

const jwtStrategy = require('../passport/jwt');
const options = {session: false, failWithError: true};
const jwtAuth = passport.authenticate('jwt', options);
passport.use(jwtStrategy);

const User = require('../models/user');

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

const router = express.Router();

router.use(formData.parse());

function missingField(requiredFields, body){
  return requiredFields.find(field => !(field in body));
}

function nonStringField(stringFields, body){
  return stringFields.find(
    field => field in body && typeof body[field] !== 'string'
  );
}

function nonTrimmedField(explicityTrimmedFields, body){
  return explicityTrimmedFields.find(
    field => body[field].trim() !== body[field]
  );
}

function tooSmallField(sizedFields, body){
  return Object.keys(sizedFields).find(
    field =>
      'min' in sizedFields[field] &&
            body[field].trim().length < sizedFields[field].min
  );
}

function tooLargeField(sizedFields, body){
  return Object.keys(sizedFields).find(
    field =>
      'max' in sizedFields[field] &&
            body[field].trim().length > sizedFields[field].max
  );
}

function capitalizeFirstLetter(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
//Get A list of all users
router.get('/', (req, res, next)=>{
  User.find({}, function(err, users) {
    let userMap = {};

    users.forEach(function(user) {
      userMap[user._id] = user;
    });

    res.send(userMap);
  })
  //get all users
})

/* CREATE A USER */
router.post('/', (req,res,next) => {
  //First do validation (dont trust client)
  const requiredFields = ['username', 'password', 'firstName', 'lastName'];

  let missing= missingField(requiredFields, req.body);

  if (missing) {
    const err = {
      message: `Missing '${missing}' in request body`,
      reason: 'ValidationError',
      location: `${missing}`,
      status: 422
    };
    return next(err);
  }

  const stringFields = ['username', 'password', 'firstName', 'lastName'];
  let notString= nonStringField(stringFields, req.body);

  if (notString) {
    const err = {
      message: 'Incorrect field type: expected string',
      reason: 'ValidationError',
      location: notString,
      status: 422
    };
    return next(err);
  }

  // If the username and password aren't trimmed we give an error.  Users might expect that these will work without trimming. We need to reject such values explicitly so the users know what's happening, rather than silently trimming them and expecting the user to understand.
  // We'll silently trim the other fields, because they aren't credentials used to log in, so it's less of a problem. QUESTION: where do we actually do
  const explicityTrimmedFields = ['username', 'password'];
  let notTrimmed = nonTrimmedField(explicityTrimmedFields, req.body);

  if (notTrimmed) {
    const err = {
      message: 'Cannot start or end with whitespace',
      reason: 'ValidationError',
      location: notTrimmed,
      status: 422
    };
    return next(err);
  }

  const sizedFields = {
    username: {
      min: 1
    },
    password: {
      min: 6,
      // bcrypt truncates after 72 characters, so let's not give the illusion of security by storing extra (unused) info
      max: 72
    }
  };

  let tooSmall = tooSmallField(sizedFields, req.body);
  let tooLarge = tooLargeField(sizedFields, req.body);

  if (tooSmall || tooLarge) {
    const message = tooSmall
      ? `Must be at least ${sizedFields[tooSmall]
        .min} characters long`
      : `Must be at most ${sizedFields[tooLarge]
        .max} characters long`;

    const err = {
      message: message,
      reason: 'ValidationError',
      location: tooSmall || tooLarge,
      status: 422
    };
    return next(err);
  }

  // // Username and password were validated as pre-trimmed, but we should trim the first and last name
  let {firstName, lastName, username, password} = req.body;
  firstName = firstName.trim();
  lastName = lastName.trim();

  //capitalize first letter of firt and first letter of last
  firstName = capitalizeFirstLetter(firstName);
  lastName = capitalizeFirstLetter(lastName);

  let photo;
  let currentUser;

  User.hashPassword(password)
    .then(digest => {
      console.log('1. CREATING USER WITH INFO', username,digest,firstName,lastName,photo);
      const newUser = {
        username,
        password: digest,
        firstName,
        lastName,
        photo: {},
      };
      return User.create(newUser);
    })
    .then(user=> {
      currentUser=user;
      if(!isEmpty(req.files)){
        console.log('2. UPLOADING TO CLOUDINARY');
        photo = Object.values(req.files);
        // first upload the image to cloudinary
        return cloudinary.uploader.upload(photo[0].path);
      }
      else{
        console.log('2. NOT UPLOADING TO CLOUDINARY');
        return null;
      }
    })
    .then(results => {
      if(results){
        console.log('3. CLOUDINARY RESULTS:', results);
        photo = {
          public_id: results.public_id,
          url: results.secure_url,
        };
        return User.findOneAndUpdate({username: currentUser.username}, {photo: photo}, {new: true} );
      }
      else{
        console.log('3. NO RESULTS:');
        return currentUser;
      }
    })
    .then(user => {
      console.log('4. USER IS', user);
      // The endpoint creates a new user in the database and responds with a 201 status, a location header and a JSON representation of the user without the password.
      return res.status(201).location(`http://${req.headers.host}/users/${user.id}`).json(user);
    })
    .catch(err => {
      if (err.code === 11000) {
        err = {
          message: 'The username already exists',
          reason: 'ValidationError',
          location: 'username',
          status: 422
        };
      }
      next(err);
    });
});

/* UPDATE A USER'S BASIC INFO */
router.put('/account', jwtAuth, (req,res,next) => {
  console.log('HERE');
  const userId = req.user.id;

  //First do validation
  const requiredFields = ['username', 'firstName', 'lastName'];
  let missing= missingField(requiredFields, req.body);


  if (missing) {
    const err = {
      message: `Missing '${missing}' in request body`,
      reason: 'ValidationError',
      location: `${missing}`,
      status: 422
    };
    return next(err);
  }

  const stringFields = ['username', 'firstName', 'lastName'];
  let notString = nonStringField(stringFields, req.body);

  if (notString) {
    const err = {
      message: 'Incorrect field type: expected string',
      reason: 'ValidationError',
      location: notString,
      status: 422
    };
    return next(err);
  }

  const explicityTrimmedFields = ['username'];
  let notTrimmed = nonTrimmedField(explicityTrimmedFields, req.body);

  if (notTrimmed) {
    const err = {
      message: 'Cannot start or end with whitespace',
      reason: 'ValidationError',
      location: notTrimmed,
      status: 422
    };
    return next(err);
  }

  const sizedFields = {
    username: {
      min: 1
    },
  };

  let tooSmall = tooSmallField(sizedFields, req.body);

  if (tooSmall) {
    const message = `Must be at least ${sizedFields[tooSmall]
      .min} characters long`;

    const err = {
      message: message,
      reason: 'ValidationError',
      location: tooSmall,
      status: 422
    };
    return next(err);
  }

  // // Username and password were validated as pre-trimmed, but we should trim the first and last
  let {firstName, lastName, username} = req.body;
  firstName = firstName.trim();
  lastName = lastName.trim();

  firstName = capitalizeFirstLetter(firstName);
  lastName = capitalizeFirstLetter(lastName);

  let updatedUser = {firstName, lastName, username};

  return User.find({_id: userId})
    .then(results => {
      let user = results[0];
      if (!user) {
        return next();
      }
      return User.findOneAndUpdate({_id: userId}, updatedUser, {new: true});
    })
    .then(user => {
      // The endpoint updates the user in the database and responds with a 201 status, a location header and a JSON representation of the user without the password.
      return res.json(user);
    })
    .catch(err => {
      if (err.code === 11000) {
        err = {
          message: 'The username already exists',
          reason: 'ValidationError',
          location: 'username',
          status: 422
        };
      }
      next(err);
    });
});

/* UPDATE A USER'S PASSWORD */
router.put('/password', jwtAuth, (req,res,next) => {
  const userId = req.user.id;

  //First do validation
  const requiredFields = ['oldPassword', 'newPassword'];
  let missing = missingField(requiredFields, req.body);

  if (missing) {
    const err = {
      message: `Missing '${missing}' in request body`,
      reason: 'ValidationError',
      location: `${missing}`,
      status: 422
    };
    return next(err);
  }

  const stringFields = ['oldPassword', 'newPassword'];
  let notString = nonStringField(stringFields, req.body);

  if (notString) {
    const err = {
      message: 'Incorrect field type: expected string',
      reason: 'ValidationError',
      location: notString,
      status: 422
    };
    return next(err);
  }

  const explicityTrimmedFields = ['newPassword'];
  let notTrimmed = nonTrimmedField(explicityTrimmedFields, req.body);

  if (notTrimmed) {
    const err = {
      message: 'Cannot start or end with whitespace',
      reason: 'ValidationError',
      location: notTrimmed,
      status: 422
    };
    return next(err);
  }

  const sizedFields = {
    newPassword: {
      min: 6,
      max: 72
    }
  };

  let tooSmall = tooSmallField(sizedFields, req.body) ;
  let tooLarge = tooLargeField(sizedFields, req.body) ;

  if ( tooSmall|| tooLarge) {
    const message = tooSmall
      ? `Must be at least ${sizedFields[tooSmall]
        .min} characters long`
      : `Must be at most ${sizedFields[tooLarge]
        .max} characters long`;

    const err = {
      message: message,
      reason: 'ValidationError',
      location: tooSmall || tooLarge,
      status: 422
    };
    return next(err);
  }


  let {oldPassword, newPassword} = req.body;

  let user;

  User.find({_id: userId})
    .then(results => {
      user = results[0];
      if (!user) {
        return next();
      }
      return user.validatePassword(oldPassword);
    })
    .then(isValid => {
      if (!isValid) {
        const err = {
          message: 'Incorrect old password',
          reason: 'ValidationError',
          location: 'oldPassword',
          status: 401
        };
        return Promise.reject(err);
      }
      return User.hashPassword(newPassword);
    })
    .then(digest => {
      const updatedUser = {password: digest};
      return User.findOneAndUpdate({_id: userId}, updatedUser, {new: true});
    })
    .then(user => {
      console.log('USER IS', user);
      return res.json(user);
    })
    .catch(err => {
      next(err);
    });
});

/* UPDATE A USER'S PROFILE PHOTO */
router.put('/photo', jwtAuth, (req,res,next) => {
  console.log("IN PHOTO ROUTE")
  const userId = req.user.id;
  const file = Object.values(req.files);

  cloudinary.uploader.upload(file[0].path)
    .then(results => {
      console.log('RESULTS from cloudinary:', results);
      let photo = {
        public_id: results.public_id,
        url: results.secure_url,
      };
      return photo;
    })
    .then(photo=>{
      return User.findOneAndUpdate({_id: userId}, {photo}, {new: true});
    })
    .then(user => {
      console.log('4. USER IS', user);
      // The endpoint creates a new user in the database and responds with a 201 status, a location header and a JSON representation of the user without the password.
      return res.status(201).location(`http://${req.headers.host}/users/${user.id}`).json(user);
    })
    .catch(err => {
      next(err);
    });
});

module.exports = router;